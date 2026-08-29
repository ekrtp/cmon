// Optional title source: the ccboard dashboard database.
//
// Measured on this machine: ~/.claude/agent-dashboard/dashboard.db holds a
// `sessions` table (173 rows) whose `name` column carries the names a person
// curated — "project-a: invoice template", "search-service: prediction beyond
// capacity cutoff" — while Claude Code's own registry only ever stores a
// derived handle. So renaming a session in that dashboard is invisible to
// everything that reads only ~/.claude/sessions, which is why the monitor kept
// showing the old title.
//
// Read only, and entirely optional: if the database, the table or node:sqlite
// is missing, every lookup simply returns nothing.
//
// node:sqlite ships with Node 22.5+ (verified working on Node 24 here), so this
// still adds no third-party dependency.

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.claude', 'agent-dashboard', 'dashboard.db');
const TTL_MS = 3000;

// Auto-generated placeholder names are not titles: "Session f6a7b8c9".
const PLACEHOLDER = /^session\s+[0-9a-f]{6,}$/i;

let sqlite = null;
let sqliteChecked = false;
let db = null;
let disabled = false;
let cache = new Map();
let cachedAt = 0;
let lastError = '';
let usageCache = new Map();
let usageAt = 0;
let agentCache = new Map();
let agentsAt = 0;
let pricing = null;

function loadSqlite() {
  if (sqliteChecked) return sqlite;
  sqliteChecked = true;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    sqlite = null;
    lastError = 'node:sqlite unavailable (needs Node 22.5+)';
  }
  return sqlite;
}

function open() {
  if (db || disabled) return db;
  const mod = loadSqlite();
  if (!mod || !fs.existsSync(DB_PATH)) {
    disabled = true;
    if (!lastError) lastError = 'dashboard.db not found';
    return null;
  }
  try {
    db = new mod.DatabaseSync(DB_PATH, { readOnly: true });
    // Fail fast if the schema is not what we expect.
    db.prepare('select id, name from sessions limit 1').get();
  } catch (e) {
    lastError = e.message;
    disabled = true;
    db = null;
  }
  return db;
}

// sessionId -> { name, status, awaitingReason, awaitingSince, model }
function refresh() {
  const handle = open();
  if (!handle) return cache;
  try {
    const rows = handle.prepare(
      'select id, name, status, awaiting_reason, awaiting_input_since, model from sessions'
    ).all();
    const next = new Map();
    for (const r of rows) {
      if (!r.id) continue;
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      next.set(r.id, {
        name: name && !PLACEHOLDER.test(name) ? name : '',
        status: r.status || '',
        awaitingReason: r.awaiting_reason || '',
        awaitingSince: r.awaiting_input_since || '',
        model: r.model || '',
      });
    }
    cache = next;
    cachedAt = Date.now();
  } catch (e) {
    // The other tool may be mid-write; keep the previous snapshot.
    lastError = e.message;
  }
  return cache;
}

function all() {
  if (Date.now() - cachedAt > TTL_MS) refresh();
  return cache;
}

function get(sessionId) {
  return all().get(sessionId) || null;
}

// Human-curated name only, '' when there is none.
function name(sessionId) {
  const row = get(sessionId);
  return row ? row.name : '';
}

// --- token usage and cost -------------------------------------------------
// token_usage holds per session/model counters; model_pricing holds $ per
// million tokens, keyed by a SQL LIKE pattern ("claude-opus-5%"). We load the
// price list once and match in JS — clearer than a LIKE join, and it lets an
// unknown model fall through to zero cost rather than vanishing from the sum.
function loadPricing() {
  if (pricing) return pricing;
  const handle = open();
  if (!handle) return (pricing = []);
  try {
    pricing = handle.prepare(
      'select model_pattern, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok from model_pricing'
    ).all().map((r) => ({
      prefix: String(r.model_pattern || '').replace(/%$/, ''),
      input: r.input_per_mtok || 0,
      output: r.output_per_mtok || 0,
      cacheRead: r.cache_read_per_mtok || 0,
      cacheWrite: r.cache_write_per_mtok || 0,
      cacheWrite1h: r.cache_write_1h_per_mtok || 0,
    }));
  } catch (e) {
    lastError = e.message;
    pricing = [];
  }
  return pricing;
}

function priceFor(model) {
  const list = loadPricing();
  let best = null;
  for (const p of list) {
    if (!p.prefix || !String(model).startsWith(p.prefix)) continue;
    // longest matching prefix wins, so "claude-opus-5" beats "claude-"
    if (!best || p.prefix.length > best.prefix.length) best = p;
  }
  return best;
}

function refreshUsage() {
  const handle = open();
  if (!handle) return usageCache;
  try {
    const rows = handle.prepare(
      'select session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens from token_usage'
    ).all();
    const next = new Map();
    for (const r of rows) {
      if (!r.session_id) continue;
      const p = priceFor(r.model || '');
      const inTok = r.input_tokens || 0;
      const outTok = r.output_tokens || 0;
      const readTok = r.cache_read_tokens || 0;
      const writeTok = r.cache_write_tokens || 0;
      const write1h = r.cache_write_1h_tokens || 0;
      const cost = p
        ? (inTok * p.input + outTok * p.output + readTok * p.cacheRead +
           writeTok * p.cacheWrite + write1h * (p.cacheWrite1h || p.cacheWrite)) / 1e6
        : 0;
      const prev = next.get(r.session_id) || { tokens: 0, billable: 0, cost: 0, priced: true };
      prev.tokens += inTok + outTok + readTok + writeTok + write1h;
      prev.billable += inTok + outTok;
      prev.cost += cost;
      if (!p) prev.priced = false;
      next.set(r.session_id, prev);
    }
    usageCache = next;
    usageAt = Date.now();
  } catch (e) {
    lastError = e.message;
  }
  return usageCache;
}

function usage(sessionId) {
  if (Date.now() - usageAt > TTL_MS) refreshUsage();
  return usageCache.get(sessionId) || null;
}

// --- sub-agents -----------------------------------------------------------
function refreshAgents() {
  const handle = open();
  if (!handle) return agentCache;
  try {
    const rows = handle.prepare(
      "select session_id, status, count(*) n from agents group by session_id, status"
    ).all();
    const next = new Map();
    for (const r of rows) {
      if (!r.session_id) continue;
      const prev = next.get(r.session_id) || { total: 0, running: 0 };
      prev.total += r.n || 0;
      if (r.status === 'running' || r.status === 'active') prev.running += r.n || 0;
      next.set(r.session_id, prev);
    }
    agentCache = next;
    agentsAt = Date.now();
  } catch (e) {
    lastError = e.message;
  }
  return agentCache;
}

function agents(sessionId) {
  if (Date.now() - agentsAt > TTL_MS) refreshAgents();
  return agentCache.get(sessionId) || null;
}

function info() {
  open();   // report the real state, not "unavailable" just because nothing asked yet
  return { path: DB_PATH, available: !disabled && !!db, entries: all().size, error: lastError };
}

function close() {
  try { if (db) db.close(); } catch (e) { /* ignore */ }
  db = null;
}

module.exports = { get, all, name, usage, agents, info, close, DB_PATH };
