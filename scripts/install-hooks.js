#!/usr/bin/env node
// Install the monitor's hooks into ~/.claude/settings.json.
//
// The monitor works WITHOUT hooks. Installing them only adds the prompt at
// submit time and Notification events. Run it only if you want that.
//
//   node scripts/install-hooks.js --dry-run   show the diff, change nothing
//   node scripts/install-hooks.js             back up, merge, write
//
// Rules this installer follows:
//   - MERGE, never rewrite. Other tools put their own hooks in this file
//     (measured on this machine: 9 belonging to a separate Electron app). They
//     are preserved untouched.
//   - Idempotent: running twice does not add the hooks twice.
//   - A timestamped backup is written first, and never deleted.
//   - If you switch accounts with a tool that swaps ~/.claude, run this again.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(__dirname, '..', 'session-hook.js');
const MARKER = 'session-hook.js';

// event -> status label passed to session-hook.js
const EVENTS = {
  SessionStart: 'started',
  UserPromptSubmit: 'thinking',
  PreToolUse: 'running',
  PostToolUse: 'working',
  Stop: 'done',
  Notification: 'asking',
  SessionEnd: 'ended',
};

const dryRun = process.argv.includes('--dry-run');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`settings.json could not be parsed: ${e.message}`);
  }
}

function command(status) {
  return `node "${HOOK.replace(/\\/g, '/')}" ${status}`;
}

// Claude Code's shape: hooks[event] = [{ matcher?, hooks: [{type, command}] }]
function alreadyInstalled(entries) {
  return (entries || []).some((group) =>
    (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER)));
}

function install() {
  const settings = readSettings();
  settings.hooks = settings.hooks || {};

  const added = [];
  const skipped = [];
  let foreign = 0;

  for (const [event, status] of Object.entries(EVENTS)) {
    const entries = settings.hooks[event] = settings.hooks[event] || [];
    foreign += entries.reduce((n, g) => n + (g.hooks || []).length, 0);

    if (alreadyInstalled(entries)) { skipped.push(event); continue; }
    entries.push({ hooks: [{ type: 'command', command: command(status) }] });
    added.push(event);
  }

  return { settings, added, skipped, foreign };
}

const { settings, added, skipped, foreign } = install();

console.log(`settings : ${SETTINGS}`);
console.log(`hook     : ${HOOK}`);
console.log(`existing : ${foreign} hook command(s) from other tools — preserved`);
console.log(`to add   : ${added.length ? added.join(', ') : '(none)'}`);
console.log(`already  : ${skipped.length ? skipped.join(', ') : '(none)'}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

if (!added.length) {
  console.log('\nNothing to do — hooks are already installed.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${SETTINGS}.backup.${stamp}`;
try {
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, backup);
  const tmp = SETTINGS + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS);
  console.log(`\nbackup   : ${fs.existsSync(backup) ? backup : '(no previous file)'}`);
  console.log('written  : hooks installed.');
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  console.error(`Your settings are untouched; a backup may exist at ${backup}`);
  process.exit(1);
}
