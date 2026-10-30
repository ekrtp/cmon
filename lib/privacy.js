// Per-session privacy: keep a chat off the board, or show nothing but its title.
//
// ~/.claude/monitor/privacy.json, shared by the table and the web board:
//
//   { "global": false,
//     "sessions": { "<sessionId>": { "level": "title", "alias": "Work", "at": 1730000000000 } },
//     "rules":    [ { "match": "ai-influencer", "level": "blocked" } ] }
//
//   visible   everything, as before
//   title     the (display) title, status, model, context and cost; nothing that
//             came out of the conversation itself
//   blocked   off the board; listed only under "blocked" / the Hidden lane
//
// A session's own entry wins, then the first rule that matches, then visible.
// `global` (screen-share mode) turns every visible session into title-only;
// blocked stays blocked. The alias, when set, replaces the title everywhere.
//
// Redaction happens here, on the server side of the board: a hidden field is
// never sent to the page or painted in the terminal, not merely styled away.
// Bad or missing file = empty defaults. Never throws on read.

const fs = require('fs');
const path = require('path');
const os = require('os');

// CLAUDE_MONITOR_PRIVACY points this module somewhere else, as
// CLAUDE_MONITOR_CONFIG does for config.js: the tests never touch the real file.
const FILE = process.env.CLAUDE_MONITOR_PRIVACY ||
  path.join(os.homedir(), '.claude', 'monitor', 'privacy.json');

const LEVELS = ['visible', 'title', 'blocked'];
const ALIAS_MAX = 60;
const MATCH_MAX = 80;

const defaults = () => ({ global: false, sessions: {}, rules: [] });
const cap = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Unknown levels are ignored, empty matches and empty entries dropped.
function sanitise(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  out.global = raw.global === true;
  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [id, e] of Object.entries(sessions)) {
    if (!id || !e || typeof e !== 'object') continue;
    const entry = {};
    if (LEVELS.includes(e.level)) entry.level = e.level;
    const alias = cap(e.alias, ALIAS_MAX);
    if (alias) entry.alias = alias;
    if (!entry.level && !entry.alias) continue;
    if (Number(e.at) > 0) entry.at = Number(e.at);
    out.sessions[id] = entry;
  }
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!r || typeof r !== 'object') continue;
    const match = cap(r.match, MATCH_MAX);
    if (!match || !['title', 'blocked'].includes(r.level)) continue;
    out.rules.push({ match, level: r.level });
  }
  return out;
}

function load() {
  try {
    return sanitise(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    return defaults();
  }
}

// Atomic, like config.js, but no backup: this file is small and rewritten on
// every click.
function write(prefs) {
  const clean = sanitise(prefs);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return clean;
}

// patch: { level?, alias? }; alias '' or null clears it. An entry that ends up
// visible with no alias is deleted — unless a rule hides this session
// (opts.ruled), where an explicit visible is the only way to take it back.
function setSession(id, patch, opts) {
  if (!id || typeof id !== 'string') return null;
  const p = patch || {};
  const prefs = load();
  const entry = { ...(prefs.sessions[id] || {}) };
  if (p.level !== undefined) {
    if (!LEVELS.includes(p.level)) return null;
    entry.level = p.level;
  }
  if (p.alias !== undefined) {
    const alias = cap(p.alias, ALIAS_MAX);
    if (alias) entry.alias = alias; else delete entry.alias;
  }
  const ruled = opts && opts.ruled;
  if (entry.level === 'visible' && !ruled) delete entry.level;
  if (!entry.level && !entry.alias) delete prefs.sessions[id];
  else prefs.sessions[id] = { ...entry, at: Date.now() };
  return write(prefs);
}

function setGlobal(on) {
  const prefs = load();
  prefs.global = !!on;
  return write(prefs);
}

function addRule(rule) {
  const r = rule || {};
  const match = cap(r.match, MATCH_MAX);
  if (!match || !['title', 'blocked'].includes(r.level)) return null;
  const prefs = load();
  prefs.rules.push({ match, level: r.level });
  return write(prefs);
}

function removeRule(index) {
  const prefs = load();
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= prefs.rules.length) return null;
  prefs.rules.splice(i, 1);
  return write(prefs);
}

// VS Code chats all share the workspace cwd, so the focus name (which project
// the conversation is about) is what most rules will hit; project and cwd catch
// terminal sessions started inside the folder.
function ruleFor(row, rules) {
  const hay = [
    row && row.focus && row.focus.name,
    row && row.project,
    row && row.cwd && String(row.cwd).replace(/\\/g, '/'),
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  return (rules || []).find((r) => {
    const m = String(r.match).replace(/\\/g, '/').toLowerCase();
    return m && hay.some((h) => h.includes(m));
  }) || null;
}

// -> { level, alias, source: 'session' | 'rule' | 'global' | 'none', ruled }
function resolve(row, prefs) {
  const p = prefs || defaults();
  const entry = (row && p.sessions && p.sessions[row.sessionId]) || {};
  const rule = ruleFor(row, p.rules);
  let level = 'visible';
  let source = 'none';
  if (entry.level) { level = entry.level; source = 'session'; }
  else if (rule) { level = rule.level; source = 'rule'; }
  if (p.global && level === 'visible') { level = 'title'; source = 'global'; }
  return { level, alias: entry.alias || '', source, ruled: !!rule };
}

// Fields a title-only or blocked row keeps. Everything else collect() builds —
// action, branch, cwd, project, focus, permissionMode, plan, recent, the agent
// tree's labels and actions, the transcript path — is content, and goes.
const KEEP = ['sessionId', 'title', 'titleSource', 'status', 'src', 'model', 'effort', 'contextTokens',
  'queued', 'cost', 'tokens', 'agents', 'lastEvent', 'empty', 'pid'];

function redact(row, resolved) {
  const r = resolved || { level: 'visible', alias: '', source: 'none', ruled: false };
  const privacy = { level: r.level, alias: !!r.alias, source: r.source, ruled: !!r.ruled };
  if (r.level === 'visible') {
    const out = { ...row, privacy };
    if (r.alias) { out.title = r.alias; out.titleSource = 'alias'; }
    return out;
  }
  const out = {};
  for (const k of KEEP) if (row[k] !== undefined) out[k] = row[k];
  if (r.alias) { out.title = r.alias; out.titleSource = 'alias'; }
  // The agent counts are numbers and stay; the agents themselves do not.
  const counts = row.tree && row.tree.counts;
  if (row.tree !== undefined) {
    out.tree = { agents: [], workflows: [], items: [], all: [],
      counts: counts ? { running: counts.running || 0, total: counts.total || 0, workflows: counts.workflows || 0 }
        : { running: 0, total: 0, workflows: 0 } };
  }
  Object.assign(out, {
    project: '', cwd: '', action: '', branch: '', permissionMode: '', statusSource: '',
    focus: null, plan: null, recent: null, jsonl: null, privacy,
  });
  return out;
}

// One write from the web board. body is one of
//   { sessionId, level } · { sessionId, alias } · { global } · { addRule: { match, level } } · { removeRule }
// ruledFor(sessionId) says whether a rule hides that session (see setSession).
// Returns true when something valid was written.
function applyRequest(body, ruledFor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  try {
    if (typeof body.sessionId === 'string' && body.sessionId) {
      if (body.level !== undefined) {
        if (!LEVELS.includes(body.level)) return false;
        return !!setSession(body.sessionId, { level: body.level },
          { ruled: ruledFor ? !!ruledFor(body.sessionId) : false });
      }
      if (body.alias !== undefined) {
        if (body.alias !== null && typeof body.alias !== 'string') return false;
        return !!setSession(body.sessionId, { alias: body.alias });
      }
      return false;
    }
    if (typeof body.global === 'boolean') return !!setGlobal(body.global);
    if (body.addRule !== undefined) return !!addRule(body.addRule);
    if (body.removeRule !== undefined) return !!removeRule(body.removeRule);
  } catch (e) { /* unwritable disk: report it as a failed request */ }
  return false;
}

// Same polling watch as config.js, so a table and a page started separately
// pick up each other's changes within a second.
function watch(onChange) {
  try {
    fs.watchFile(FILE, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        try { onChange(load()); } catch (e) { /* keep the previous prefs */ }
      }
    });
  } catch (e) { /* watching is optional */ }
  return () => { try { fs.unwatchFile(FILE); } catch (e) { /* ignore */ } };
}

module.exports = {
  load, sanitise, watch, setSession, setGlobal, addRule, removeRule, resolve, redact,
  applyRequest, ruleFor, FILE, LEVELS, ALIAS_MAX, MATCH_MAX,
};
