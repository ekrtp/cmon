// Desktop notification when a session starts waiting on you.
//
// Fires on a transition into `asking` or `interrupted` — never on every frame,
// and never on the first frame after startup (otherwise starting the monitor
// would fire one notification per already-waiting session).
//
// Uses the bundled notify.ps1 (NotifyIcon balloon tip), spawned detached so a
// slow PowerShell start never blocks the render loop. Notifications are opt-in:
// "notifications": true in ~/.claude/monitor/config.json.

const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'notify.ps1');
const COOLDOWN_MS = 60000;   // per session, so a flapping status cannot spam

const lastStatus = new Map();   // sessionId -> status at the previous frame
const lastSent = new Map();     // sessionId -> timestamp
let primed = false;             // the first frame only records, never notifies

const WANTS_YOU = new Set(['asking', 'interrupted']);

const MESSAGES = {
  asking: 'is waiting for your answer',
  interrupted: 'was interrupted',
};

function send(title, message, project) {
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Title', title, '-Message', message, '-Project', project || '',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

// rows: what the renderer is about to draw. Returns how many notifications went
// out, so the footer can say so.
function check(rows, enabled, sendFn) {
  let sent = 0;
  const now = Date.now();
  const deliver = sendFn || send;

  for (const row of rows) {
    const previous = lastStatus.get(row.sessionId);
    lastStatus.set(row.sessionId, row.status);

    if (!primed || !enabled) continue;
    if (!WANTS_YOU.has(row.status)) continue;
    if (previous === row.status) continue;               // not a transition
    if (now - (lastSent.get(row.sessionId) || 0) < COOLDOWN_MS) continue;

    if (deliver(row.title, `${row.title} ${MESSAGES[row.status]}`, row.project)) {
      lastSent.set(row.sessionId, now);
      sent++;
    }
  }

  primed = true;
  return sent;
}

// Sessions that have gone away should not keep state around.
function forget(liveIds) {
  for (const id of [...lastStatus.keys()]) if (!liveIds.has(id)) lastStatus.delete(id);
  for (const id of [...lastSent.keys()]) if (!liveIds.has(id)) lastSent.delete(id);
}

// Test seam: forget everything, including the "first frame" priming.
function reset() {
  lastStatus.clear();
  lastSent.clear();
  primed = false;
}

module.exports = { check, forget, send, reset, SCRIPT, COOLDOWN_MS };
