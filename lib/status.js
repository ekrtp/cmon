// Status derivation — read from the transcript, not from hooks.
//
// Why not hooks: the previous implementation took status from
// ~/.claude/claude-monitor-status/<project>.json, which is keyed by PROJECT.
// Every chat in the same workspace overwrites the same file, so N-1 sessions
// showed a status belonging to a different session (measured: 20 files, only
// working/done/running ever present). The transcript is per session and already
// carries the exact signal.
//
// Signals used (all measured over 984 transcript lines):
//   assistant.message.stop_reason === 'tool_use'  -> a tool is executing
//   assistant tool_use block name                 -> which tool (LAST ACTION)
//   tool_use name === 'AskUserQuestion'           -> Claude is asking you
//   assistant.message.stop_reason === 'end_turn'  -> turn finished, your move
//   user line carrying tool_result                -> model is generating
//   user text '[Request interrupted by user]'     -> you stopped it
//   toolDenialKind                                -> a permission was refused
//   type 'queue-operation'                        -> you queued messages
// Also harvested from the same read: message.model, gitBranch, effort,
// permissionMode, version.

const fs = require('fs');
const jsonl = require('./jsonl');

const TAIL_BYTES = 64 * 1024;

// Ordered by how much they demand your attention; the renderer uses these keys
// for theme colours too.
const STATUS = {
  asking: 'asking',            // yellow: Claude needs an answer or approval
  interrupted: 'interrupted',  // yellow: you stopped it
  running: 'running',          // blue: tool executing
  thinking: 'thinking',        // purple: model generating
  done: 'done',                // green: turn complete
  idle: 'idle',                // grey: nothing happening
};

const ATTENTION = { asking: 0, interrupted: 1, running: 2, thinking: 3, done: 4, idle: 5 };

// Line types that say nothing about who is waiting on whom.
const NOISE = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta',
  'ai-title', 'custom-title', 'atis-latch', 'last-prompt', 'mode', 'system',
]);

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text).join(' ');
  }
  return '';
}

function toolUseBlocks(message) {
  const c = message && message.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === 'tool_use' && b.name);
}

function hasToolResult(message) {
  const c = message && message.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && b.type === 'tool_result');
}

// Returns a full snapshot for one session. Never throws.
function derive(jsonlPath, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const idleAfterMs = o.idleAfterMs || 120000;

  const out = {
    status: STATUS.idle,
    action: '',
    model: '',
    branch: '',
    effort: '',
    permissionMode: '',
    version: '',
    contextTokens: 0, // how full the context window is, from the newest usage
    queued: 0,        // pending messages a person typed
    queuedAll: 0,     // including internal notifications
    denied: false,
    lastEventMs: 0,
    source: 'none',
  };
  if (!jsonlPath) return out;

  let lines;
  try {
    const st = fs.statSync(jsonlPath);
    out.lastEventMs = st.mtimeMs;
    const edges = jsonl.readEdges(jsonlPath, 0, TAIL_BYTES);
    lines = edges.tail.length ? edges.tail : edges.head;
  } catch (e) {
    return out;
  }

  // Parse the tail once, newest last.
  const parsed = [];
  for (const raw of lines) {
    const o2 = jsonl.parse(raw);
    if (o2) parsed.push(o2);
  }
  if (!parsed.length) return out;

  // Metadata: take the newest occurrence of each field.
  let denialIndex = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    if (!out.branch && p.gitBranch) out.branch = p.gitBranch;
    if (!out.version && p.version) out.version = p.version;
    if (!out.effort && p.effort) out.effort = p.effort;
    if (!out.permissionMode && p.permissionMode) out.permissionMode = p.permissionMode;
    if (!out.model && p.message && p.message.model) out.model = p.message.model;

    // Context occupancy: the newest assistant turn reports what it was sent.
    // input + cache_read + cache_creation is what actually occupied the window.
    if (!out.contextTokens && p.message && p.message.usage) {
      const u = p.message.usage;
      out.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
                          (u.cache_creation_input_tokens || 0);
    }
    if (p.toolDenialKind && denialIndex < i) denialIndex = i;

    // Queue depth. Measured operations: enqueue 21, remove 11, dequeue 10 — so
    // counting enqueues alone reports a queue that has long since drained.
    // Only entries a person actually typed are interesting; the internal ones
    // (task notifications and similar) arrive wrapped in <tags>.
    if (p.type === 'queue-operation') {
      const internal = typeof p.content === 'string' && p.content.trim().startsWith('<');
      const delta = p.operation === 'enqueue' ? 1 : (p.operation === 'remove' || p.operation === 'dequeue' ? -1 : 0);
      out.queuedAll += delta;
      if (!internal) out.queued += delta;
    }
  }

  // Find the newest line that actually indicates whose turn it is. Sub-agent
  // turns (isSidechain) belong to a nested agent, not to the session's own turn.
  let decided = null;
  let decidedIndex = -1;
  for (let i = parsed.length - 1; i >= 0 && !decided; i--) {
    const p = parsed[i];
    if (NOISE.has(p.type) || p.isSidechain === true) continue;
    decidedIndex = i;

    if (p.type === 'assistant' && p.message) {
      const tools = toolUseBlocks(p.message);
      const ask = tools.find((t) => t.name === 'AskUserQuestion');
      if (ask) {
        decided = { status: STATUS.asking, action: 'AskUserQuestion', source: 'ask-tool' };
      } else if (tools.length || p.message.stop_reason === 'tool_use') {
        decided = { status: STATUS.running, action: tools.length ? tools[tools.length - 1].name : 'tool', source: 'stop_reason' };
      } else {
        decided = { status: STATUS.done, action: '', source: 'stop_reason' };
      }
      break;
    }

    if (p.type === 'user' && p.message) {
      if (hasToolResult(p.message)) {
        decided = { status: STATUS.thinking, action: '', source: 'tool_result' };
      } else {
        const t = textOf(p.message).trim();
        if (/^\[Request interrupted/.test(t)) {
          decided = { status: STATUS.interrupted, action: '', source: 'interrupt-marker' };
        } else {
          decided = { status: STATUS.thinking, action: '', source: 'user-turn' };
        }
      }
      break;
    }
  }

  // The tail is a window, not the whole file: a negative net means we saw more
  // removals than enqueues, which reads as an empty queue.
  out.queued = Math.max(0, out.queued);
  out.queuedAll = Math.max(0, out.queuedAll);

  if (decided) {
    out.status = decided.status;
    out.action = decided.action;
    out.source = decided.source;
  }

  // A tool that "runs" for longer than idleAfterMs is almost always a session
  // sitting at a permission prompt or an abandoned window: report it honestly.
  const gap = now - out.lastEventMs;
  if ((out.status === STATUS.running || out.status === STATUS.thinking) && gap > idleAfterMs) {
    out.status = STATUS.idle;
    out.source += '+stalled';
  }

  // A refused permission outranks running/idle, but ONLY while it is the newest
  // signal in the transcript. An older denial that the model already worked past
  // must not keep the row yellow forever.
  out.denied = denialIndex >= 0;
  if (out.denied && denialIndex >= decidedIndex && gap < idleAfterMs &&
      (out.status === STATUS.running || out.status === STATUS.idle)) {
    out.status = STATUS.asking;
    out.source += '+denial';
  }

  return out;
}

module.exports = { derive, STATUS, ATTENTION, TAIL_BYTES };
