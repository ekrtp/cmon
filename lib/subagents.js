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
// Cost: the board refreshes every ~2 s. A session with no subagents/ directory
// costs one stat(). Everything else is cached on (mtime, size); a finished
// agent's node is cached for good; transcripts are read from a 32 KB tail,
// widened only when a single oversized line fills it. Measured over 8 live
// sessions carrying 95 sub-agents: 125 ms for the first frame, 5–7 ms after.
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
const OPEN = new Set(['running', 'thinking', 'asking']);
const WORKFLOW_AGENT = 'workflow-subagent';

const transcripts = new Map();     // file -> { mtimeMs, size, raw }
const metas = new Map();           // file -> { mtimeMs, size, meta }
const journals = new Map();        // file -> incremental journal state
const runFiles = new Map();        // <runId>.json path -> { mtimeMs, size, info }
const scriptNames = new Map();     // sessionId/runId -> name
const metaDirs = new Map();        // sessionId -> { at, dirs }
let projectList = { at: 0, root: '', dirs: [] };

// Counts every read of file CONTENT (not stats). The tests use it to prove an
// unchanged file is not read twice.
const stats = { reads: 0 };

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
  if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return e.meta;
  const meta = readJson(file) || {};
  metas.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
  return meta;
}

// The transcript's status WITHOUT the stall rule, cached on (mtime, size): the
// stall depends on the clock, not on the file, so it is applied by settle().
function rawStatus(file, st) {
  const e = transcripts.get(file);
  if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return e.raw;
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
  transcripts.set(file, { mtimeMs: st.mtimeMs, size: st.size, raw });
  return raw;
}

// The same stall rule sessions get (lib/status.js): running or thinking with
// nothing written for idleAfterMs is a dead or stuck agent, and so is a
// permission denial nobody answered.
function settle(raw, lastEventMs, now, idleAfterMs) {
  const stalled = now - lastEventMs > idleAfterMs;
  if (!stalled) return raw.status;
  if (raw.status === 'running' || raw.status === 'thinking') return 'idle';
  if (raw.status === 'asking' && /\+denial/.test(raw.source)) return 'idle';
  return raw.status;
}

// One agent from its meta and transcript. `ended` is a verdict from a workflow
// journal ('done' / 'interrupted'), which outranks the transcript.
function agentNode(id, meta, mst, tFile, o, ended) {
  const tst = statOf(tFile);
  const startedMs = mst ? mst.mtimeMs : (tst ? (tst.birthtimeMs || tst.mtimeMs) : 0);
  let status;
  let action = '';
  let lastEventMs;
  if (ended) {
    status = ended;
    lastEventMs = tst ? tst.mtimeMs : startedMs;
  } else if (tst) {
    const raw = rawStatus(tFile, tst);
    lastEventMs = tst.mtimeMs;
    status = settle(raw, lastEventMs, o.now, o.idleAfterMs);
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
    out.push(agentNode(id, meta, mst, path.join(dir, `agent-${id}.jsonl`), o, null));
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
    const prev = j.agents.get(agentId);
    j.agents.set(agentId, {
      agentId,
      label: typeof obj.label === 'string' ? obj.label : '',
      phase: typeof obj.phase === 'string' ? obj.phase : '',
      order: prev ? prev.order : j.agents.size,
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
    j = { offset: 0, mtimeMs: 0, birthMs: 0, agents: new Map(), byKey: new Map(), phase: '', launched: false };
    journals.set(file, j);
  }
  j.birthMs = st.birthtimeMs || st.mtimeMs;
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
  if (hit && hit.root === root && now - hit.at <= DIR_TTL_MS) return hit.dirs;
  const dirs = [own];
  for (const d of projectDirs(root, now)) {
    const w = path.join(d, sessionId, 'workflows');
    if (w !== own && statOf(w)) dirs.push(w);
  }
  metaDirs.set(sessionId, { at: now, root, dirs });
  return dirs;
}

function runInfo(runId, dirs) {
  for (const d of dirs) {
    const f = path.join(d, runId + '.json');
    const st = statOf(f);
    if (!st) continue;
    const e = runFiles.get(f);
    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return e.info;
    const j = readJson(f);
    if (!j) continue;   // half-written: try again next tick
    const info = {
      name: typeof j.workflowName === 'string' ? j.workflowName : '',
      status: typeof j.status === 'string' ? j.status : 'completed',
      startMs: Number(j.startTime) || 0,
      finishedMs: Number(j.startTime) && Number(j.durationMs)
        ? Number(j.startTime) + Number(j.durationMs) : st.mtimeMs,
    };
    runFiles.set(f, { mtimeMs: st.mtimeMs, size: st.size, info });
    return info;
  }
  return null;
}

function scriptName(sessionId, runId, dirs) {
  const key = `${sessionId}/${runId}`;
  if (scriptNames.has(key)) return scriptNames.get(key);
  const suffix = `-${runId}.js`;
  for (const d of dirs) {
    let list;
    try { list = fs.readdirSync(path.join(d, 'scripts')); } catch (e) { continue; }
    const hit = list.find((n) => n.endsWith(suffix));
    if (hit) {
      const name = hit.slice(0, -suffix.length);
      scriptNames.set(key, name);
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
    const node = agentNode(a.agentId, meta, mst, path.join(runDir, `agent-${a.agentId}.jsonl`), o, ended);
    node.label = a.label || node.label;
    node.phase = a.phase || meta.workflowPhase || '';
    node.order = a.order;
    if (ended) a.final = node;   // a result never changes: cache it for good
    agents.push(node);
    lastEventMs = Math.max(lastEventMs, node.lastEventMs);
  }
  agents.sort((x, y) => x.order - y.order);

  const open = agents.filter((a) => OPEN.has(a.status));
  let status;
  let state;
  if (info) {
    status = info.status;
    state = /^(completed|complete|succeeded|success|done)$/i.test(status) ? 'done' : 'interrupted';
    lastEventMs = info.finishedMs || lastEventMs;
  } else {
    status = 'running';
    // Between two agents the script itself is working: still running, until
    // nothing has moved for idleAfterMs.
    state = open.length || o.now - lastEventMs <= o.idleAfterMs ? 'running' : 'idle';
  }

  const finished = agents.filter((a) => !OPEN.has(a.status))
    .sort((x, y) => y.lastEventMs - x.lastEventMs).slice(0, FINISHED_SHOWN);
  const shown = agents.filter((a) => OPEN.has(a.status) || finished.includes(a));

  return {
    runId,
    name,
    status,
    state,
    phase: (j && j.phase) || (agents.length ? agents[agents.length - 1].phase : ''),
    done: agents.length - open.length,
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
const EMPTY = () => ({ agents: [], workflows: [], items: [], counts: { running: 0, total: 0, workflows: 0 }, overflow: 0 });

function options(opts) {
  const o = opts || {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    now: num(o.now, Date.now(), 1),
    idleAfterMs: num(o.idleAfterMs, 120000, 1),
    lingerMs: num(o.lingerMs, LINGER_MS, 0),
    maxLines: Math.floor(num(o.maxLines, MAX_LINES, 1)),
    projectsDir: o.projectsDir || '',
  };
}

// Visible nodes, most useful first, trimmed to maxLines. Open nodes keep their
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

  const cost = (it) => (it.kind === 'workflow' ? 1 + it.node.agents.length : 1);
  const needed = items.reduce((s, it) => s + cost(it), 0);
  if (needed <= o.maxLines) return { items, overflow: 0 };

  // Reserve the last line for "+N more".
  let room = o.maxLines - 1;
  const kept = [];
  for (const it of items) {
    if (room <= 0) break;
    if (cost(it) <= room) { kept.push(it); room -= cost(it); continue; }
    if (it.kind === 'workflow') {
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
  const shown = kept.reduce((s, it) => s + cost(it), 0);
  return { items: kept, overflow: needed - shown };
}

// forSession(sessionId, jsonlPath, opts) -> {
//   agents, workflows      the visible nodes of each kind
//   items                  the same nodes in display order: [{ kind, node, open }]
//   counts                 { running, total, workflows } over EVERYTHING, visible or not
//   overflow               lines cut by maxLines ("+N more")
// }
// opts: { now, idleAfterMs, lingerMs, maxLines, projectsDir }. projectsDir
// defaults to the directory above the transcript's own project directory.
function forSession(sessionId, jsonlPath, opts) {
  try {
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
    const { items, overflow } = arrange(plain, runs, o);
    return {
      agents: items.filter((it) => it.kind === 'agent').map((it) => it.node),
      workflows: items.filter((it) => it.kind === 'workflow').map((it) => it.node),
      items,
      counts,
      overflow,
    };
  } catch (e) {
    return EMPTY();
  }
}

function reset() {
  for (const m of [transcripts, metas, journals, runFiles, scriptNames, metaDirs]) m.clear();
  projectList = { at: 0, root: '', dirs: [] };
  stats.reads = 0;
}

module.exports = { forSession, TAIL_BYTES, LINGER_MS, MAX_LINES, _stats: stats, _reset: reset };
