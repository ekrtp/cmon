#!/usr/bin/env node
// Claude Code Session Monitor
// Run in a dedicated terminal: node "$USERPROFILE/.claude/monitor.js"

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const sessionsDir  = path.join(os.homedir(), '.claude', 'claude-monitor-status');
const projectsDir  = path.join(os.homedir(), '.claude', 'projects');
const claudeSessionsDir = path.join(os.homedir(), '.claude', 'sessions'); // Claude Code's own registry — read-only
const STALE_MS     = 2 * 60 * 60 * 1000;

// Read Claude Code's own session registry (*.key files) to map sessionId -> friendly name.
// Read-only: never write here, this directory belongs to Claude Code itself.
function loadSessionNames() {
  const map = {};
  try {
    if (!fs.existsSync(claudeSessionsDir)) return map;
    fs.readdirSync(claudeSessionsDir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir, f), 'utf8'));
          if (s && s.sessionId && s.name) map[s.sessionId] = s.name;
        } catch (_) {}
      });
  } catch (_) {}
  return map;
}

// Decode Claude's encoded project dir name to a real path
// e.g. "C--Users-you-CascadeProjects-postwriter" -> "C:\Users\you\CascadeProjects\postwriter"
function decodeDirName(dirName) {
  // Replace first -- with :\ then remaining - with \
  return dirName.replace('--', ':\\').replace(/-/g, '\\');
}

// Find which project dir contains a given session ID
function sessionIdToProject(sessionId) {
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir);
      try {
        const files = fs.readdirSync(dirPath);
        if (files.some(f => f.startsWith(sessionId))) {
          const decoded = decodeDirName(dir);
          // Try to resolve the actual path to get correct basename
          const segments = decoded.split('\\').filter(Boolean);
          return segments[segments.length - 1] || dir;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Get running Claude sessions from process list
function getLiveSessions() {
  try {
    const raw = execSync(
      'powershell.exe -NonInteractive -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like \'*claude-code/cli.js*\' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
      { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    if (!raw) return [];
    const list = JSON.parse(raw);
    const procs = Array.isArray(list) ? list : [list];
    return procs.map(p => {
      const resumeMatch = p.CommandLine && p.CommandLine.match(/--resume\s+([a-f0-9-]{36})/);
      const sessionId = resumeMatch ? resumeMatch[1] : null;
      const project = sessionId ? sessionIdToProject(sessionId) : null;
      return { pid: p.ProcessId, sessionId, project };
    }).filter(p => p.project);
  } catch (_) {
    return [];
  }
}

// ANSI helpers
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const DIM = '\x1b[2m';
const colors = {
  working:  '\x1b[33m',
  thinking: '\x1b[36m',
  waiting:  '\x1b[91m',
  done:     '\x1b[32m',
  idle:     '\x1b[32m',
  running:  '\x1b[37m',
};
const icons = {
  working:  '🔧',
  thinking: '🤔',
  waiting:  '⏳',
  done:     '✅',
  idle:     '💤',
  running:  '·',
};

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)    return 'now';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function pad(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function render() {
  const lines = [];
  const now   = Date.now();

  // 1. Read hook-written session files
  const fileMap = {};
  if (fs.existsSync(sessionsDir)) {
    fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
          if (s && (now - s.timestamp) < STALE_MS) fileMap[s.project] = s;
        } catch (_) {}
      });
  }

  // 2. Merge with live processes — adds sessions not yet touched by hooks
  getLiveSessions().forEach(p => {
    if (p.project && !fileMap[p.project]) {
      fileMap[p.project] = { project: p.project, status: 'running', message: 'idle', sessionId: p.sessionId, timestamp: now };
    } else if (p.project && fileMap[p.project] && !fileMap[p.project].sessionId) {
      fileMap[p.project].sessionId = p.sessionId;
    }
  });

  // 3. Attach friendly session names from Claude Code's own registry
  const sessionNames = loadSessionNames();
  Object.values(fileMap).forEach(s => {
    if (s.sessionId && sessionNames[s.sessionId]) s.name = sessionNames[s.sessionId];
  });

  let sessions = Object.values(fileMap).sort((a, b) => {
    if (a.status === 'waiting' && b.status !== 'waiting') return -1;
    if (b.status === 'waiting' && a.status !== 'waiting') return  1;
    return b.timestamp - a.timestamp;
  });

  const waiting = sessions.filter(s => s.status === 'waiting').length;
  const header  = waiting > 0
    ? `${B}\x1b[91m Claude Monitor  ⚠  ${waiting} need${waiting > 1 ? 's' : ''} your attention ${R}`
    : `${B} Claude Monitor ${R}`;

  const width   = 90;
  const divider = `${DIM}${'─'.repeat(width)}${R}`;

  lines.push('');
  lines.push(`  ${header}   ${DIM}${new Date().toLocaleTimeString()}${R}`);
  lines.push(`  ${divider}`);

  if (sessions.length === 0) {
    lines.push(`  ${DIM}No active sessions. Start Claude Code in any project.${R}`);
  } else {
    const COL = { project: 16, name: 14, status: 13, msg: 14, sid: 10, time: 4 };
    lines.push(`  ${B}${pad('PROJECT', COL.project)} ${pad('NAME', COL.name)} ${pad('STATUS', COL.status)} ${pad('LAST ACTION', COL.msg)} ${pad('SESSION ID', COL.sid)} TIME${R}`);
    lines.push(`  ${divider}`);

    for (const s of sessions) {
      const color = colors[s.status] || DIM;
      const icon  = icons[s.status]  || '·';
      const proj  = pad(s.project.substring(0, COL.project - 1), COL.project);
      const name  = pad((s.name || '-').substring(0, COL.name - 1), COL.name);
      const stat  = pad(`${icon} ${s.status}`, COL.status);
      const msg   = pad((s.message || '').substring(0, COL.msg - 1), COL.msg);
      const sid   = pad(s.sessionId ? s.sessionId.substring(0, 8) : '--------', COL.sid);
      const ago   = timeAgo(s.timestamp);

      if (s.status === 'waiting') {
        lines.push(`  ${B}${color}${proj} ${name} ${stat} ${msg} ${DIM}${sid}${R}${B}${color} ${ago}  ← you${R}`);
      } else {
        lines.push(`  ${proj} ${DIM}${name}${R} ${color}${stat}${R} ${DIM}${msg} ${sid} ${ago}${R}`);
      }
    }
  }

  lines.push(`  ${divider}`);
  lines.push(`  ${DIM}${sessions.length} session(s) · refreshes every 2s · Ctrl+C to exit${R}`);
  lines.push('');

  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n'));
}

render();
setInterval(render, 2000);
