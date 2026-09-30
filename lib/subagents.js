// Sub-agents and workflow runs of one session, as a small tree for the board.
//
// Why: /workflows only works in the terminal that started the run, so a session
// in the IDE extension gives you no way to see which workflow agent is doing
// what. Everything needed is already on disk, next to the transcript.
//
// Measured (Claude Code 2.1.x, Windows):
//   ~/.claude/projects/<enc>/<sessionId>.jsonl                 the session
//   ~/.claude/projects/<enc>/<sessionId>/subagents/
//     agent-<id>.jsonl + agent-<id>.meta.json                  Agent-tool sub-agents
//       meta: {"agentType":"general-purpose","description":"…","model":"sonnet",…}
//       A meta can exist with NO transcript yet (just spawned) — and, measured,
//       a meta can also stay orphaned for hours, so a missing transcript only
//       means "starting" while the meta is fresh.
//       Every transcript line is isSidechain:true, which is why status.derive()
//       is called with { sidechain: true } here.
//     workflows/<runId>/journal.jsonl                          one workflow run
//       {"type":"launched"}
//       {"type":"started","key":"v2:…","agentId":"a93e…","label":"impl-1","phase":"Task 1"}
//       {"type":"result","key":"v2:…","agentId":"a93e…","result":{…}}
//       A result line can be 35 KB (measured), so the journal is read
//       incrementally from the last offset and result lines are never parsed.
//       A resumed or retried run writes `started` AGAIN for the same key with a
//       NEW agentId (measured: 11 started lines over 6 keys, agentCount 6, and
//       only the second attempts got a result). The key is the agent; the
//       newest agentId is its current attempt and the older one is dropped.
//       Only a result line makes an agent done: a quiet transcript does not.
//     workflows/<runId>/agent-<id>.jsonl + .meta.json          its agents
//       meta: {"agentType":"workflow-subagent","description":"review-2","workflowPhase":"Task 2",…}
//       A finished workflow agent ends on StructuredOutput followed by a
//       tool_result carrying toolEndsTurn:true.
//   ~/.claude/projects/*/<sessionId>/workflows/<runId>.json     written when a run ENDS
//       { workflowName, status: "completed", agentCount, durationMs, startTime, … }
//   ~/.claude/projects/*/<sessionId>/workflows/scripts/<name>-<runId>.js   present while running
//   Both of those are searched in EVERY project directory: a session's cwd can
//   move mid-session, and measured, one session's scripts sat under a different
//   project directory than its transcript and its <runId>.json.
//
// Stalls: a sub-agent goes quiet for much longer than a session does. Measured
// over 164 sub-agent transcripts, the longest silence while still working was
// 745 s after a Bash call, 707 s after a tool result and 414 s after a text
// block; none passed 900 s. So sub-agents get their own threshold
// (agentIdleAfterMs, 15 min) instead of the session's 2 min.
//
// Cost: the board refreshes every ~2 s. A session with no subagents/ directory
// costs one stat(). Everything else is cached on (mtime, size); a finished
// agent's node is cached for good; transcripts are read from a 32 KB tail,
// widened only when a single oversized line fills it. Measured over 8 live
// sessions carrying 95 sub-agents: 125 ms for the first frame, 5–7 ms after.
// Cache entries nobody asked for in FORGET_MS (a session that ended, a
// deleted run) are swept, so a board left running for days does not grow.
//
// Read only. Never throws. No dependencies.

const fs = require('fs');
const path = require('path');
const statusLib = require('./status');

const TAIL_BYTES = 32 * 1024;
const WINDOWS = [TAIL_BYTES, 256 * 1024, 1024 * 1024];
const LINGER_MS = 10 * 60000;
const MAX_LINES = 8;
const FINISHED_SHOWN = 2;          // finished agents kept visible inside a workflow
const DIR_TTL_MS = 10000;          // how long a project-directory listing is trusted
const AGENT_IDLE_MS = 15 * 60000;  // see "Stalls" above
const FORGET_MS = 10 * 60000;      // cache entries unused this long are dropped
const SWEEP_EVERY_MS = 60000;
const OPEN = new Set(['running', 'thinking', 'asking']);
const WORKFLOW_AGENT = 'workflow-subagent';

const transcripts = new Map();     // file -> { mtimeMs, size, raw, seen }
const metas = new Map();           // file -> { mtimeMs, size, meta, seen }
const journals = new Map();        // file -> incremental journal state (+ seen)
const runFiles = new Map();        // <runId>.json path -> { mtimeMs, size, info, seen }
const scriptNames = new Map();     // sessionId/runId -> { name, seen }
const metaDirs = new Map();        // sessionId -> { at, root, dirs, seen }
const CACHES = [transcripts, metas, journals, runFiles, scriptNames, metaDirs];
let projectList = { at: 0, root: '', dirs: [] };
let lastSweep = 0;

// Counts every read of file CONTENT (not stats). The tests use it to prove an
// unchanged file is not read twice.
const stats = { reads: 0 };

// Wall clock, not opts.now: the sweep is about memory, not about the board.
const touch = (e) => { e.seen = Date.now(); return e; };

function sweep(wallNow) {
  const now = wallNow || Date.now();
  for (const m of CACHES) {
    for (const [k, e] of m) if (!(now - (e.seen || 0) <= FORGET_MS)) m.delete(k);
  }
  lastSweep = now;
}

function statOf(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

function readJson(p) {
  stats.reads++;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function metaOf(file, st) {
  if (!st) return {};
  const e = metas.get(file);
  if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return touch(e).meta;
  const meta = readJson(file) || {};
  metas.set(file, touch({ mtimeMs: st.mtimeMs, size: st.size, meta }));
  return meta;
}

// The transcript's status WITHOUT the stall rule, cached on (mtime, size): the
// stall depends on the clock, not on the file, so it is applied by settle().
function rawStatus(file, st) {
  const e = transcripts.get(file);
  if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return touch(e).raw;
  // One tool result can be bigger than the whole window (measured: 316 KB lines,
  // and 6 of 148 agent transcripts had one among their last three), which
  // leaves the tail with nothing but a cut-off line. Widen only then.
  let raw = null;
  for (const tailBytes of WINDOWS) {
    stats.reads++;
    raw = statusLib.derive(file, {
      sidechain: true, tailBytes, idleAfterMs: Number.MAX_SAFE_INTEGER, now: st.mtimeMs,
    });
    if (raw.source !== 'none' || tailBytes >= st.size) break;
  }
  transcripts.set(file, touch({ mtimeMs: st.mtimeMs, size: st.size, raw }));
  return raw;
}

// The stall rule sessions get (lib/status.js), on the sub-agent threshold:
// running or thinking with nothing written for agentIdleAfterMs is a dead or
// stuck agent, and so is a permission denial nobody answered.
// A text block with no stop_reason is nearly always followed by more (measured
// 1346 times over 164 transcripts), but a plain sub-agent can also END on one
// (measured once): once it has been quiet that long it is read as done.
// `pending` is a workflow agent the journal has no result for: the journal,
// not the transcript, decides when it is done.
function settle(raw, lastEventMs, now, idleAfterMs, pending) {
  const stalled = now - lastEventMs > idleAfterMs;
  if (!stalled) return raw.status;
  if (raw.source === 'partial-text') return pending ? 'idle' : 'done';
  if (raw.status === 'running' || raw.status === 'thinking') return 'idle';
  if (raw.status === 'asking' && /\+denial/.test(raw.source)) return 'idle';
  return raw.status;
}

// One agent from its meta and transcript. `ended` is a verdict from a workflow
// journal ('done' / 'interrupted'), which outranks the transcript; `pending`
// marks a workflow agent still waiting for one, and `hintMs` is when its
// started line was seen — the only clock such an agent has before its meta
// and transcript appear.
function agentNode(id, meta, mst, tFile, o, ended, pending, hintMs) {
  const tst = statOf(tFile);
  const startedMs = mst ? mst.mtimeMs : (tst ? (tst.birthtimeMs || tst.mtimeMs) : (hintMs || 0));
  let status;
  let action = '';
  let lastEventMs;
  if (ended) {
    status = ended;
    lastEventMs = tst ? tst.mtimeMs : startedMs;
  } else if (tst) {
    const raw = rawStatus(tFile, tst);
    lastEventMs = tst.mtimeMs;
    status = settle(raw, lastEventMs, o.now, o.agentIdleAfterMs, pending);
    if (OPEN.has(status)) action = raw.action || '';
  } else {
    // Spawned, nothing written yet: starting — unless the meta is old.
    lastEventMs = startedMs;
    status = o.now - startedMs <= o.idleAfterMs ? 'thinking' : 'idle';
  }
  return {
    id,
    label: String(meta.description || `agent ${String(id).slice(0, 7)}`).replace(/\s+/g, ' ').trim(),
    type: meta.agentType || '',
    model: meta.model || '',
    status,
    action,
    startedMs,
    lastEventMs,
  };
}

function plainAgents(dir, o) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const ids = new Set();
  for (const n of names) {
    const m = /^agent-(.+?)\.(?:meta\.json|jsonl)$/.exec(n);
    if (m) ids.add(m[1]);
  }
  const out = [];
  for (const id of ids) {
    const metaFile = path.join(dir, `agent-${id}.meta.json`);
    const mst = statOf(metaFile);
    const meta = metaOf(metaFile, mst);
    if (meta.agentType === WORKFLOW_AGENT) continue;   // belongs to a run directory
    out.push(agentNode(id, meta, mst, path.join(dir, `agent-${id}.jsonl`), o, null, false));
  }
  return out;
}

// --- workflow journal -------------------------------------------------------
const ENDING = /error|fail|skip|cancel|abort|kill|timeout/i;

function ingest(j, line) {
  if (!line || line.trim()[0] !== '{') return;
  const head = line.slice(0, 400);
  const sniff = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(head);
  let type = sniff ? sniff[1] : '';
  let obj = null;
  // Result lines are the big ones and only their agentId matters: never parse
  // them. Everything else is small enough to parse, or is skipped.
  if (type !== 'result') {
    if (line.length > 64 * 1024) return;
    try { obj = JSON.parse(line); } catch (e) { return; }
    if (!obj || typeof obj !== 'object') return;
    type = String(obj.type || '');
  }
  if (type === 'launched') { j.launched = true; return; }

  let agentId = obj ? obj.agentId : '';
  const key = obj ? obj.key : ((/"key"\s*:\s*"([^"]+)"/.exec(head) || [])[1] || '');
  if (!agentId && !obj) agentId = (/"agentId"\s*:\s*"([^"]+)"/.exec(head) || [])[1] || '';
  if (!agentId && key) agentId = j.byKey.get(key) || '';
  if (!agentId) return;

  if (type === 'started') {
    // A second start for the same key is a new attempt of the same agent: it
    // replaces the old one, in the old one's place.
    const supersededId = key ? j.byKey.get(key) : '';
    const superseded = supersededId && supersededId !== agentId ? j.agents.get(supersededId) : null;
    if (superseded) j.agents.delete(supersededId);
    const prev = j.agents.get(agentId) || superseded;
    j.agents.set(agentId, {
      agentId,
      label: typeof obj.label === 'string' ? obj.label : '',
      phase: typeof obj.phase === 'string' ? obj.phase : '',
      order: prev ? prev.order : j.seq++,
      seenMs: j.readMs || 0,
      ended: null,
      final: null,
    });
    if (key) j.byKey.set(key, agentId);
    if (obj.phase) j.phase = String(obj.phase);
    return;
  }
  const a = j.agents.get(agentId);
  if (!a) return;
  if (type === 'result') { a.ended = 'done'; a.final = null; return; }
  // Unknown types are ignored unless they plainly end the agent.
  if (ENDING.test(type) && !a.ended) { a.ended = 'interrupted'; a.final = null; }
}

// Reads only the bytes appended since the last call, and only whole lines.
function journalOf(file) {
  const st = statOf(file);
  if (!st) return null;
  let j = journals.get(file);
  if (!j || st.size < j.offset) {
    j = {
      offset: 0, mtimeMs: -1, size: -1, birthMs: 0, seq: 0,
      agents: new Map(), byKey: new Map(), phase: '', launched: false,
    };
    journals.set(file, j);
  }
  touch(j);
  j.birthMs = st.birthtimeMs || st.mtimeMs;
  // Unchanged since the last look: nothing to read, not even a cut-off last
  // line that would otherwise be re-read and re-parsed on every tick.
  if (st.mtimeMs === j.mtimeMs && st.size === j.size) return j;
  j.size = st.size;
  j.readMs = st.mtimeMs;
  if (st.size > j.offset) {
    stats.reads++;
    let buf = null;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(st.size - j.offset);
        fs.readSync(fd, buf, 0, buf.length, j.offset);
      } finally { fs.closeSync(fd); }
    } catch (e) { buf = null; }
    if (buf) {
      const cut = buf.lastIndexOf(0x0a);
      if (cut >= 0) {
        for (const line of buf.slice(0, cut).toString('utf8').split('\n')) ingest(j, line);
        j.offset += cut + 1;
      }
      // A remainder with no newline is complete only if it parses; otherwise it
      // is a half-written line and the next tick reads it again.
      const rest = buf.slice(cut + 1).toString('utf8');
      if (rest.trim()) {
        let whole = false;
        try { JSON.parse(rest); whole = true; } catch (e) { whole = false; }
        if (whole) { ingest(j, rest); j.offset += buf.length - (cut + 1); }
      }
    }
  }
  j.mtimeMs = st.mtimeMs;
  return j;
}

// --- workflow metadata, across project directories --------------------------
function projectDirs(root, now) {
  if (projectList.root !== root || now - projectList.at > DIR_TTL_MS) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).map((d) => path.join(root, d)); } catch (e) { dirs = []; }
    projectList = { at: now, root, dirs };
  }
  return projectList.dirs;
}

// Every <project>/<sessionId>/workflows directory, the session's own first.
function workflowMetaDirs(sessionId, sessionDir, root, now) {
  const own = path.join(sessionDir, 'workflows');
  const hit = metaDirs.get(sessionId);
  if (hit && hit.root === root && now - hit.at <= DIR_TTL_MS) return touch(hit).dirs;
  const dirs = [own];
  for (const d of projectDirs(root, now)) {
    const w = path.join(d, sessionId, 'workflows');
    if (w !== own && statOf(w)) dirs.push(w);
  }
  metaDirs.set(sessionId, touch({ at: now, root, dirs }));
  return dirs;
}

function runInfo(runId, dirs) {
  for (const d of dirs) {
    const f = path.join(d, runId + '.json');
    const st = statOf(f);
    if (!st) continue;
    const e = runFiles.get(f);
    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return touch(e).info;
    const j = readJson(f);
    if (!j) continue;   // half-written: try again next tick
    const info = {
      name: typeof j.workflowName === 'string' ? j.workflowName : '',
      status: typeof j.status === 'string' ? j.status : 'completed',
      startMs: Number(j.startTime) || 0,
      finishedMs: Number(j.startTime) && Number(j.durationMs)
        ? Number(j.startTime) + Number(j.durationMs) : st.mtimeMs,
    };
    runFiles.set(f, touch({ mtimeMs: st.mtimeMs, size: st.size, info }));
    return info;
  }
  return null;
}

function scriptName(sessionId, runId, dirs) {
  const key = `${sessionId}/${runId}`;
  if (scriptNames.has(key)) return touch(scriptNames.get(key)).name;
  const suffix = `-${runId}.js`;
  for (const d of dirs) {
    let list;
    try { list = fs.readdirSync(path.join(d, 'scripts')); } catch (e) { continue; }
    const hit = list.find((n) => n.endsWith(suffix));
    if (hit) {
      const name = hit.slice(0, -suffix.length);
      scriptNames.set(key, touch({ name }));
      return name;
    }
  }
  return '';
}

function workflowNode(sessionId, runDir, runId, dirs, o) {
  const j = journalOf(path.join(runDir, 'journal.jsonl'));
  const info = runInfo(runId, dirs);
  const name = (info && info.name) || scriptName(sessionId, runId, dirs) || runId;

  const agents = [];
  let lastEventMs = j ? j.mtimeMs : 0;
  for (const a of j ? j.agents.values() : []) {
    if (a.final) { agents.push(a.final); lastEventMs = Math.max(lastEventMs, a.final.lastEventMs); continue; }
    const metaFile = path.join(runDir, `agent-${a.agentId}.meta.json`);
    const mst = statOf(metaFile);
    const meta = metaOf(metaFile, mst);
    // Once the run itself has ended, nothing inside it is still going.
    const ended = a.ended || (info ? 'idle' : null);
    const node = agentNode(a.agentId, meta, mst, path.join(runDir, `agent-${a.agentId}.jsonl`), o, ended, !ended, a.seenMs);
    node.label = a.label || node.label;
    node.phase = a.phase || meta.workflowPhase || '';
    node.order = a.order;
    node.verdict = a.ended || '';
    if (ended) a.final = node;   // a result never changes: cache it for good
    agents.push(node);
    lastEventMs = Math.max(lastEventMs, node.lastEventMs);
  }
  agents.sort((x, y) => x.order - y.order);

  const open = agents.filter((a) => OPEN.has(a.status));
  // Done means the journal has its result, or its transcript ended the turn
  // (StructuredOutput) a moment before the result line lands. An agent that
  // merely went quiet has not finished, however long the silence.
  const done = agents.filter((a) => a.verdict === 'done' || (!a.verdict && a.status === 'done')).length;
  let status;
  let state;
  if (info) {
    status = info.status;
    state = /^(completed|complete|succeeded|success|done)$/i.test(status) ? 'done' : 'interrupted';
    lastEventMs = info.finishedMs || lastEventMs;
  } else {
    status = 'running';
    // Between two agents the script itself is working: still running, until
    // nothing has moved for the sub-agent stall threshold.
    state = open.length || o.now - lastEventMs <= o.agentIdleAfterMs ? 'running' : 'idle';
  }

  // Stuck agents (started, no result, run not over) stay visible: they are
  // not finished, and are the ones worth a look.
  const stuck = (a) => !info && !a.verdict && !OPEN.has(a.status) && a.status !== 'done';
  const finished = agents.filter((a) => !OPEN.has(a.status) && !stuck(a))
    .sort((x, y) => y.lastEventMs - x.lastEventMs).slice(0, FINISHED_SHOWN);
  const shown = agents.filter((a) => OPEN.has(a.status) || stuck(a) || finished.includes(a));

  return {
    runId,
    name,
    status,
    state,
    phase: (j && j.phase) || (agents.length ? agents[agents.length - 1].phase : ''),
    done,
    total: agents.length,
    running: open.length,
    startedMs: (info && info.startMs) || (j ? j.birthMs : 0),
    lastEventMs,
    agents: shown,
  };
}

function workflowRuns(sessionId, sessionDir, root, o) {
  const base = path.join(sessionDir, 'subagents', 'workflows');
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return []; }
  const runs = entries.filter((d) => d.isDirectory());
  if (!runs.length) return [];
  const dirs = workflowMetaDirs(sessionId, sessionDir, root, o.now);
  const out = [];
  for (const d of runs) {
    try { out.push(workflowNode(sessionId, path.join(base, d.name), d.name, dirs, o)); } catch (e) { /* skip one bad run */ }
  }
  return out;
}

// --- the tree ----------------------------------------------------------------
const EMPTY = () => ({
  agents: [], workflows: [], items: [], all: [],
  counts: { running: 0, total: 0, workflows: 0 }, overflow: 0, hidden: { workflows: 0, agents: 0 },
});

function options(opts) {
  const o = opts || {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    now: num(o.now, Date.now(), 1),
    // The session threshold: only for a meta with no transcript yet.
    idleAfterMs: num(o.idleAfterMs, 120000, 1),
    agentIdleAfterMs: num(o.agentIdleAfterMs, AGENT_IDLE_MS, 1),
    lingerMs: num(o.lingerMs, LINGER_MS, 0),
    maxLines: Math.floor(num(o.maxLines, MAX_LINES, 1)),
    projectsDir: o.projectsDir || '',
  };
}

// Visible nodes, most useful first (trim() applies maxLines). Open nodes keep their
// start order so a live row does not jump around every refresh; finished ones
// follow, newest first.
function arrange(plain, runs, o) {
  const recent = (ms) => o.now - ms <= o.lingerMs;
  const items = [];
  for (const w of runs) {
    const open = OPEN.has(w.state);
    if (open || recent(w.lastEventMs)) items.push({ kind: 'workflow', node: w, open });
  }
  for (const a of plain) {
    const open = OPEN.has(a.status);
    if (open || recent(a.lastEventMs)) items.push({ kind: 'agent', node: a, open });
  }
  items.sort((x, y) => {
    if (x.open !== y.open) return x.open ? -1 : 1;
    if (x.kind !== y.kind) return x.kind === 'workflow' ? -1 : 1;
    return x.open ? x.node.startedMs - y.node.startedMs : y.node.lastEventMs - x.node.lastEventMs;
  });
  return items;
}

const cost = (it) => (it.kind === 'workflow' ? 1 + it.node.agents.length : 1);
const agentsIn = (it) => (it.kind === 'workflow' ? it.node.agents.length : 1);

// Trim display-ordered items to maxLines. What is cut is reported as nodes,
// not lines — { workflows, agents } — so "+N more" never counts a workflow's
// heading line as an agent.
function trim(items, maxLines) {
  const none = { workflows: 0, agents: 0 };
  const needed = items.reduce((s, it) => s + cost(it), 0);
  if (needed <= maxLines) return { items, overflow: 0, hidden: none };

  // Reserve the last line for "+N more".
  let room = maxLines - 1;
  const kept = [];
  for (const it of items) {
    if (room <= 0) break;
    if (cost(it) <= room) { kept.push(it); room -= cost(it); continue; }
    if (it.kind === 'workflow' && room >= 1) {
      // The workflow line fits, some of its agents do not: keep the open ones.
      const agents = it.node.agents.slice()
        .sort((x, y) => (OPEN.has(y.status) - OPEN.has(x.status)))
        .slice(0, room - 1)
        .sort((x, y) => x.order - y.order);
      kept.push({ ...it, node: { ...it.node, agents } });
      room -= 1 + agents.length;
    }
    break;
  }
  // `kept` is a prefix of `items`; only its last entry can be a cut copy.
  const hidden = { workflows: 0, agents: 0 };
  items.forEach((it, i) => {
    const k = kept[i];
    if (!k) { if (it.kind === 'workflow') hidden.workflows++; hidden.agents += agentsIn(it); return; }
    hidden.agents += agentsIn(it) - agentsIn(k);
  });
  return { items: kept, overflow: hidden.workflows + hidden.agents, hidden };
}

// Re-trim a tree forSession() already built to a smaller line budget (the
// renderer's, when the terminal is short). Works on the demo's trees too.
function fit(tree, maxLines) {
  if (!tree) return EMPTY();
  const whole = Boolean(tree.all && tree.all.length);
  const cut = trim(whole ? tree.all : (tree.items || []), Math.max(1, Math.floor(maxLines)));
  // Without `all`, what was cut before stays cut, on top of this cut.
  const before = whole ? { workflows: 0, agents: 0 } : (tree.hidden || { workflows: 0, agents: tree.overflow || 0 });
  const hidden = { workflows: cut.hidden.workflows + before.workflows, agents: cut.hidden.agents + before.agents };
  return { ...tree, items: cut.items, overflow: hidden.workflows + hidden.agents, hidden };
}

// How many lines a tree occupies as built: its items plus the "+N more" line.
function lineCount(tree) {
  if (!tree || !tree.items || !tree.items.length) return tree && tree.overflow ? 1 : 0;
  return tree.items.reduce((s, it) => s + cost(it), 0) + (tree.overflow ? 1 : 0);
}

// What is still working in the background, from forSession().counts:
// 'workflow' when a run is going — also between two of its agents, when none
// is open — else 'agents' when a sub-agent is, else ''.
function busy(counts) {
  if (!counts) return '';
  if (counts.workflows) return 'workflow';
  return counts.running ? 'agents' : '';
}

// forSession(sessionId, jsonlPath, opts) -> {
//   agents, workflows      the visible nodes of each kind
//   items                  the same nodes in display order: [{ kind, node, open }]
//   counts                 { running, total, workflows } over EVERYTHING, visible or not
//   all                    every visible node before the maxLines cut (for fit())
//   overflow, hidden       what maxLines cut, as nodes: hidden = { workflows, agents },
//                          overflow = their sum ("+N more")
// }
// opts: { now, idleAfterMs, agentIdleAfterMs, lingerMs, maxLines, projectsDir }.
// projectsDir defaults to the directory above the transcript's own project
// directory.
function forSession(sessionId, jsonlPath, opts) {
  try {
    if (Date.now() - lastSweep > SWEEP_EVERY_MS) sweep();
    if (!sessionId || !jsonlPath) return EMPTY();
    const sessionDir = path.join(path.dirname(jsonlPath), sessionId);
    const subDir = path.join(sessionDir, 'subagents');
    if (!statOf(subDir)) return EMPTY();   // the common case: one stat, nothing else
    const o = options(opts);
    const root = o.projectsDir || path.dirname(path.dirname(jsonlPath));

    const plain = plainAgents(subDir, o);
    const runs = workflowRuns(sessionId, sessionDir, root, o);

    const counts = {
      running: plain.filter((a) => OPEN.has(a.status)).length + runs.reduce((s, w) => s + w.running, 0),
      total: plain.length + runs.reduce((s, w) => s + w.total, 0),
      workflows: runs.filter((w) => OPEN.has(w.state)).length,
    };
    const all = arrange(plain, runs, o);
    const { items, overflow, hidden } = trim(all, o.maxLines);
    return {
      agents: items.filter((it) => it.kind === 'agent').map((it) => it.node),
      workflows: items.filter((it) => it.kind === 'workflow').map((it) => it.node),
      items,
      all,
      counts,
      overflow,
      hidden,
    };
  } catch (e) {
    return EMPTY();
  }
}

function reset() {
  for (const m of CACHES) m.clear();
  projectList = { at: 0, root: '', dirs: [] };
  stats.reads = 0;
}

const cacheSize = () => CACHES.reduce((n, m) => n + m.size, 0);

module.exports = {
  forSession, fit, lineCount, busy, TAIL_BYTES, LINGER_MS, MAX_LINES, AGENT_IDLE_MS, FORGET_MS,
  _stats: stats, _reset: reset, _sweep: sweep, _cacheSize: cacheSize,
};
