#!/usr/bin/env node
// Remove this monitor's hooks from ~/.claude/settings.json, leaving every other
// tool's hooks exactly where they are.
//
//   node scripts/uninstall-hooks.js --dry-run
//   node scripts/uninstall-hooks.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARKER = 'session-hook.js';
const dryRun = process.argv.includes('--dry-run');

let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  console.log(`Nothing to do: ${SETTINGS} is missing or unreadable (${e.code || e.message}).`);
  process.exit(0);
}

const removed = [];
let kept = 0;

for (const [event, entries] of Object.entries(settings.hooks || {})) {
  if (!Array.isArray(entries)) continue;
  const next = [];
  for (const group of entries) {
    const hooks = (group.hooks || []).filter((h) => {
      const mine = typeof h.command === 'string' && h.command.includes(MARKER);
      if (mine) removed.push(event);
      else kept++;
      return !mine;
    });
    // Drop a group only if it became empty and had no other keys worth keeping.
    if (hooks.length) next.push({ ...group, hooks });
    else if (Object.keys(group).some((k) => k !== 'hooks' && k !== 'matcher')) next.push({ ...group, hooks });
  }
  settings.hooks[event] = next;
}

console.log(`settings : ${SETTINGS}`);
console.log(`removing : ${removed.length ? [...new Set(removed)].join(', ') : '(none)'}`);
console.log(`keeping  : ${kept} hook command(s) from other tools`);

if (dryRun) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
if (!removed.length) { console.log('\nNothing to do.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${SETTINGS}.backup.${stamp}`;
try {
  fs.copyFileSync(SETTINGS, backup);
  const tmp = SETTINGS + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS);
  console.log(`\nbackup   : ${backup}`);
  console.log('written  : hooks removed.');
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
}
