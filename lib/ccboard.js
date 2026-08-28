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

function info() {
  return { path: DB_PATH, available: !disabled && !!db, entries: cache.size, error: lastError };
}

function close() {
  try { if (db) db.close(); } catch (e) { /* ignore */ }
  db = null;
}

module.exports = { get, all, name, info, close, DB_PATH };
