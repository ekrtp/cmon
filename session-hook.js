#!/usr/bin/env node
// Claude Code hook target. Reads the hook payload on stdin and writes one small
// state file per SESSION: ~/.claude/monitor/state/<sessionId>.json
//
// Upstream wrote ~/.claude/sessions/<project>.json, which was wrong twice over:
// that directory is Claude Code's own registry, and keying by project meant
// every chat in one workspace overwrote the same file.
//
// The monitor does not need this hook — titles and statuses come from the
// transcript. What a hook adds is the prompt at submit time (before the
// transcript is flushed) and Notification events. Keep it FAST: a Node process
// starts on every tool call, so this file only ever writes a small JSON.
//
// Usage in settings.json (scripts/install-hooks.js does this for you):
//   node <path>/session-hook.js <status>

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'monitor', 'state');
const status = process.argv[2] || 'idle';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) { payload = {}; }

  // The payload carries cwd; process.env.PWD is usually undefined on Windows.
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id || payload.sessionId || '';
  const target = sessionId
    ? path.join(STATE_DIR, sessionId + '.json')
    : path.join(STATE_DIR, `unknown-${process.pid}.json`);

  const record = {
    sessionId,
    cwd,
    project: path.basename(cwd),
    status,
    lastAction: payload.tool_name || payload.message || '',
    pid: process.pid,
    updatedAt: Date.now(),
  };
  if (!sessionId) record.warning = 'no session_id in payload (older Claude Code?)';

  // Keep the first prompt we ever see for this session: it is an instant title
  // for a session whose transcript has not produced an ai-title yet.
  try {
    const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (previous && previous.firstPrompt) record.firstPrompt = previous.firstPrompt;
  } catch (e) { /* no previous file */ }

  if (!record.firstPrompt && typeof payload.prompt === 'string' && payload.prompt.trim()) {
    record.firstPrompt = payload.prompt.trim().slice(0, 200);
  }

  // Atomic write: the monitor reads on a 2 second loop and must never catch a
  // half-written file.
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = target + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) { /* a monitor state file is never worth failing a hook over */ }

  process.exit(0);
});
