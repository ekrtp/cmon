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
  events = events.slice(-KEEP);
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

// Feed every fresh snapshot. Returns today's events, newest last.
function observe(rows, extras) {
  const d = today();
  if (d !== day) { load(d); prev = null; }
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
        if (old && old.state === 'running' && w.state !== 'running') {
          emit({ ...base, type: 'workflow', name: w.name, status: w.state, total: w.total,
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
