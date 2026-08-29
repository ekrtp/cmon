// Task list progress, read from ~/.claude/tasks/.
//
// Measured on this machine: 66 directories, named either <sessionId> or
// session-<first 8 of sessionId>, each holding <n>.json files shaped
//   { id, subject, description, activeForm, status, blocks, blockedBy }
// with status one of pending | in_progress | completed. That is the session's
// plan, not a background job queue — so the monitor can show how far a session
// has got and what it is on right now.
//
// Read only. 38 of the 66 directories were empty, which is normal: a session
// that never wrote a plan has no files.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const TTL_MS = 4000;

const cache = new Map();   // sessionId -> { at, value }

function readDirSafe(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function candidateDirs(sessionId) {
  return [
    path.join(TASKS_DIR, sessionId),
    path.join(TASKS_DIR, 'session-' + sessionId.slice(0, 8)),
  ];
}

// { total, completed, inProgress, pending, current } — current is the subject of
// the task in progress, when there is one.
// Read one task directory. Exported for the fixture tests.
function progressIn(dir) {
  const files = readDirSafe(dir).filter((f) => /^\d+\.json$/.test(f));
  if (!files.length) return null;

  const out = { total: 0, completed: 0, inProgress: 0, pending: 0, current: '' };
  for (const f of files) {
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      continue;  // half-written task file: skip, never crash
    }
    if (!task || typeof task !== 'object') continue;
    out.total++;
    if (task.status === 'completed') out.completed++;
    else if (task.status === 'in_progress') {
      out.inProgress++;
      if (!out.current) out.current = task.activeForm || task.subject || '';
    } else out.pending++;
  }
  return out.total ? out : null;
}

function progress(sessionId) {
  if (!sessionId) return null;
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  for (const dir of candidateDirs(sessionId)) {
    value = progressIn(dir);
    if (value) break;
  }

  cache.set(sessionId, { at: Date.now(), value });
  return value;
}

module.exports = { progress, progressIn, TASKS_DIR };
