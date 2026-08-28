#!/usr/bin/env node
// Called by Claude Code hooks to write session status
// Usage: node session-hook.js <status>

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const status      = process.argv[2] || 'idle';
const sessionsDir = path.join(os.homedir(), '.claude', 'claude-monitor-status');
const mapFile     = path.join(os.homedir(), '.claude', 'session-map.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  let message = '';
  let sessionId = '';
  try {
    const data = JSON.parse(input);
    if (data.session_id)   sessionId = data.session_id;
    if (data.tool_name)    message   = data.tool_name;
    else if (data.message) message   = data.message;
    else if (data.type)    message   = data.type;
  } catch (_) {}

  const cwd     = process.env.PWD || process.cwd();
  const project = path.basename(cwd);

  fs.mkdirSync(sessionsDir, { recursive: true });

  // Write session status file
  fs.writeFileSync(
    path.join(sessionsDir, project + '.json'),
    JSON.stringify({ project, status, message, cwd, sessionId, timestamp: Date.now() })
  );

  // Persist session ID → project mapping for crash recovery
  if (sessionId) {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (_) {}
    map[sessionId] = { project, cwd, firstSeen: map[sessionId]?.firstSeen || new Date().toISOString(), lastSeen: new Date().toISOString() };
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
  }
});
