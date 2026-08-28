// The only platform-specific file in the fork (Windows-first by design).
//
// Upstream spawned powershell.exe every 2 seconds to scan processes over WMI.
// That is unnecessary: process.kill(pid, 0) sends no signal, it only asks
// whether the process exists. Measured on this machine: ESRCH for a missing
// pid, so the check is reliable and costs microseconds.

// ESRCH -> gone. EPERM -> alive but not ours to signal (still alive).
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { isAlive };
