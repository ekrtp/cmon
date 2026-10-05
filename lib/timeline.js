// "What finished today": events derived by comparing one snapshot with the next.
//
//   session   running/thinking -> done | asking | interrupted
//   workflow  running -> done | interrupted (with its agent count and cost)
//   agent     a plain sub-agent that finished
//   task      a plan task that moved to completed
//
// One JSON line per event in ~/.claude/monitor/timeline/<YYYY-MM-DD>.jsonl (cmon's
// own directory, never Claude Code's), so a restart keeps the day. Events that
// happened while cmon was not running are not reconstructed.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude', 'monitor', 'timeline');
const KEEP = 400;
const OPEN = new Set(['running', 'thinking']);

let day = '';
let events = [];
let prev = null;   // sessionId -> { status, title, workflows: Map, agents: Map, tasks: Map }

const today = () => new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD, local time
const fileFor = (d) => path.join(DIR, d + '.jsonl');

function load(d) {
  day = d;
  events = [];
  try {
    for (const line of fs.readFileSync(fileFor(d), 'utf8').split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (e) { /* half-written line */ }
    }
  } catch (e) { /* no file yet */ }
  events = events.sort((a, b) => a.at - b.at).slice(-KEEP);
}

function emit(ev) {
  events.push(ev);
  if (events.length > KEEP) events.shift();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(day), JSON.stringify(ev) + '\n', 'utf8');
  } catch (e) { /* read-only disk: keep it in memory */ }
}

function shape(row) {
  const workflows = new Map();
  const agents = new Map();
  for (const it of (row.tree && row.tree.all) || []) {
    if (it.kind === 'workflow') workflows.set(it.node.runId, it.node);
    else agents.set(it.node.id, it.node);
  }
  const tasks = new Map(((row.plan && row.plan.list) || []).map((t) => [t.id, t]));
  return { status: row.status, title: row.title, workflows, agents, tasks };
}

// Backfill what happened today before cmon was watching, from records Claude Code
// keeps anyway: a workflow's <runId>.json (written when it ends) and a session's
// last reply. Each is added once; `seeded` remembers what was checked.
const seeded = new Set();
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); };

function seed(rows) {
  const since = startOfToday();
  const have = new Set(events.map((e) => e.runId || `${e.type}|${e.sessionId}|${e.at}`));
  for (const r of rows) {
    if (!r.jsonl) continue;
    const dir = path.join(path.dirname(r.jsonl), r.sessionId, 'workflows');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) { /* none */ }
    for (const n of names) {
      const key = r.sessionId + '/' + n;
      if (seeded.has(key)) continue;
      seeded.add(key);
      try {
        const w = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        const end = (w.startTime || 0) + (w.durationMs || 0);
        if (end < since || have.has(w.runId)) continue;
        emit({ at: end, type: 'workflow', runId: w.runId, sessionId: r.sessionId, title: r.title,
          focus: r.focus ? r.focus.name : '', name: w.workflowName || w.runId,
          status: /^(completed|done|succeeded)$/i.test(w.status) ? 'done' : 'interrupted',
          total: w.agentCount || 0, durationMs: w.durationMs || 0, tokens: w.totalTokens || 0 });
      } catch (e) { /* half-written or foreign */ }
    }
    const at = r.recent && r.recent.replyAt;
    const skey = 'session/' + r.sessionId + '/' + at;
    if (at && at >= since && !OPEN.has(r.status) && !seeded.has(skey)) {
      seeded.add(skey);
      const dup = events.some((e) => e.type === 'session' && e.sessionId === r.sessionId && Math.abs(e.at - at) < 5 * 60000);
      if (!dup) emit({ at, type: 'session', sessionId: r.sessionId, title: r.title, focus: r.focus ? r.focus.name : '', status: 'done' });
    }
  }
  events.sort((a, b) => a.at - b.at);
}

// Feed every fresh snapshot. Returns today's events, newest last.
function observe(rows, extras) {
  const d = today();
  if (d !== day) { load(d); prev = null; seeded.clear(); }
  seed(rows);
  const next = new Map(rows.map((r) => [r.sessionId, shape(r)]));
  const at = Date.now();

  if (prev) {
    for (const r of rows) {
      const was = prev.get(r.sessionId);
      if (!was) continue;
      const now = next.get(r.sessionId);
      const base = { at, sessionId: r.sessionId, title: r.title, focus: r.focus ? r.focus.name : '' };

      if (OPEN.has(was.status) && !OPEN.has(now.status) && now.status !== 'idle') {
        emit({ ...base, type: 'session', status: now.status, action: r.action || '' });
      }
      for (const [id, w] of now.workflows) {
        const old = was.workflows.get(id);
        if (old && old.state === 'running' && w.state !== 'running' && !events.some((e) => e.runId === id)) {
          emit({ ...base, type: 'workflow', runId: id, name: w.name, status: w.state, total: w.total,
            durationMs: w.startedMs ? at - w.startedMs : 0, cost: extras && extras.runCost ? extras.runCost(r, id) : 0 });
        }
      }
      for (const [id, a] of now.agents) {
        const old = was.agents.get(id);
        if (old && OPEN.has(old.status) && !OPEN.has(a.status) && a.status !== 'asking') {
          emit({ ...base, type: 'agent', name: a.label || a.description || id, status: a.status });
        }
      }
      for (const [id, t] of now.tasks) {
        const old = was.tasks.get(id);
        if (old && old.status !== 'completed' && t.status === 'completed') {
          emit({ ...base, type: 'task', name: t.subject });
        }
      }
    }
  }
  prev = next;
  return events;
}

module.exports = { observe, DIR };
