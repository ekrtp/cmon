// Our own state, one file per session: ~/.claude/monitor/state/<sessionId>.json
//
// Never write to ~/.claude/sessions/ — that is Claude Code's registry.
//
// Status no longer comes from here: lib/status.js derives it from the transcript,
// which is per session and always present. This module remains for what only a
// hook can know (the prompt as it is submitted, notification events) and it
// still reads the legacy ~/.claude/claude-monitor-status/<project>.json files so
// an existing install keeps contributing whatever it has.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'monitor', 'state');
const LEGACY_DIR = path.join(os.homedir(), '.claude', 'claude-monitor-status');

function readDir(dir) {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return out;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && typeof j === 'object') out.push({ file: path.join(dir, f), record: j });
    } catch (e) {
      // half-written file: skip it, never crash (acceptance criterion 7)
    }
  }
  return out;
}

// sessionId -> record. Our own directory wins over the legacy one.
function bySession() {
  const map = new Map();

  const add = (j, origin) => {
    const id = j.sessionId;
    if (!id) return;
    const when = j.updatedAt || j.timestamp || 0;
    const prev = map.get(id);
    if (prev && prev.origin === 'own' && origin === 'legacy') return;
    if (prev && prev.origin === origin && prev.when > when) return;
    map.set(id, {
      origin,
      when,
      status: j.status || '',
      lastAction: j.lastAction || j.message || '',
      firstPrompt: j.firstPrompt || '',
      cwd: j.cwd || '',
    });
  };

  for (const { record } of readDir(LEGACY_DIR)) add(record, 'legacy');
  for (const { record } of readDir(STATE_DIR)) add(record, 'own');
  return map;
}

// Atomic write: tmp + rename, so a reader on a 2 second loop never sees a
// half-written file.
function write(record) {
  if (!record || !record.sessionId) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const target = path.join(STATE_DIR, record.sessionId + '.json');
  const tmp = target + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, target);
  return true;
}

// Stale files are MOVED to _archived/, never deleted. Returns what moved.
function archiveStale(liveSessionIds, staleMs) {
  const moved = [];
  const archive = path.join(STATE_DIR, '_archived');
  const now = Date.now();
  for (const { file, record } of readDir(STATE_DIR)) {
    const when = record.updatedAt || record.timestamp || 0;
    if (record.sessionId && liveSessionIds.has(record.sessionId)) continue;
    if (now - when < staleMs) continue;
    try {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(file, path.join(archive, path.basename(file)));
      moved.push(path.basename(file));
    } catch (e) { /* ignore */ }
  }
  return moved;
}

module.exports = { bySession, write, archiveStale, STATE_DIR, LEGACY_DIR };
