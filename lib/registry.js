// Claude Code's OWN session registry: ~/.claude/sessions/<PID>.json
//
// READ ONLY. This directory belongs to Claude Code — writing here was the
// upstream bug (it polluted the registry). Our own state lives in lib/state.js.
//
// Measured (docs/DATA-SOURCES.md): all 33 records carry pid, sessionId, cwd,
// startedAt, kind, entrypoint. A `name` field exists too, but nameSource is
// "derived" in 33/33 records and the value looks like "vscode-dd" — it is a
// generated handle, not a title, so it never reaches the UI.
//
// The <PID>.<hash>.key files in the same directory are never touched.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isAlive } = require('./platform/win32');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

function shape(j) {
  return {
    pid: j.pid,
    sessionId: j.sessionId,
    cwd: j.cwd || '',
    startedAt: j.startedAt || 0,
    kind: j.kind || '',
    entrypoint: j.entrypoint || '',   // claude-vscode | cli | …
    version: j.version || '',
    // Kept for diagnostics only — see the note above.
    derivedName: j.name || '',
    nameSource: j.nameSource || '',
  };
}

function readAll() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  const records = [];
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch (e) {
      continue; // a half-written record must not crash the monitor
    }
    if (!j || !j.sessionId || !j.pid) continue;
    const r = shape(j);
    r.alive = isAlive(r.pid);
    records.push(r);
  }
  return records;
}

// One entry per sessionId. The same id can appear in two records (measured:
// c3d4e5f6 under both claude-vscode and cli) — prefer the live one, then the
// most recently started.
function liveSessions() {
  const bySession = new Map();
  for (const r of readAll()) {
    const prev = bySession.get(r.sessionId);
    const better = !prev ||
      (r.alive && !prev.alive) ||
      (r.alive === prev.alive && r.startedAt > prev.startedAt);
    if (better) bySession.set(r.sessionId, r);
  }
  return [...bySession.values()].filter((r) => r.alive);
}

module.exports = { liveSessions, readAll, SESSIONS_DIR };
