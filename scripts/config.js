#!/usr/bin/env node
// Edit ~/.claude/monitor/config.json without hand-writing JSON. The running
// monitor picks changes up immediately (the config is watched).
//
//   node scripts/config.js                     show the current config
//   node scripts/config.js set theme light     set one key
//   node scripts/config.js set refreshMs 1000
//   node scripts/config.js columns +cost -branch
//   node scripts/config.js columns status,title,cost,time
//   node scripts/config.js defaults            rewrite with the defaults
//
// A timestamped backup is written before every change, and never deleted.

const fs = require('fs');
const configLib = require('../lib/config');
const themes = require('../lib/themes');

const [command, ...rest] = process.argv.slice(2);

function backupAndWrite(next) {
  configLib.ensureFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${configLib.FILE}.backup.${stamp}`;
  try { fs.copyFileSync(configLib.FILE, backup); } catch (e) { /* first run */ }
  const tmp = configLib.FILE + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configLib.FILE);
  console.log(`written : ${configLib.FILE}`);
  console.log(`backup  : ${backup}`);
}

// What is on disk, not the sanitised view — editing must not silently rewrite
// keys the user set by hand.
function onDisk() {
  try { return JSON.parse(fs.readFileSync(configLib.FILE, 'utf8')); } catch (e) { return { ...configLib.DEFAULTS }; }
}

function show() {
  const raw = onDisk();
  console.log(`config  : ${configLib.FILE}`);
  console.log(JSON.stringify(raw, null, 2));
  console.log(`\nthemes  : ${themes.names().join(', ')}`);
  console.log(`columns : ${configLib.COLUMN_NAMES.join(', ')}`);
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

if (!command || command === 'show') {
  show();
} else if (command === 'defaults') {
  backupAndWrite({ ...configLib.DEFAULTS });
} else if (command === 'set') {
  const [key, ...valueParts] = rest;
  if (!key || !valueParts.length) {
    console.error('usage: node scripts/config.js set <key> <value>');
    process.exit(1);
  }
  const raw = onDisk();
  raw[key] = coerce(valueParts.join(' '));
  backupAndWrite(raw);
  console.log(`${key} = ${JSON.stringify(raw[key])}`);
} else if (command === 'columns') {
  const raw = onDisk();
  let columns = Array.isArray(raw.columns) ? raw.columns.slice() : [...configLib.DEFAULTS.columns];

  const tokens = rest.join(',').split(',').map((s) => s.trim()).filter(Boolean);
  const relative = tokens.every((t) => t.startsWith('+') || t.startsWith('-'));

  if (!tokens.length) {
    console.log(`columns : ${columns.join(', ')}`);
    console.log(`known   : ${configLib.COLUMN_NAMES.join(', ')}`);
    process.exit(0);
  }

  if (relative) {
    for (const t of tokens) {
      const name = t.slice(1);
      if (!configLib.COLUMN_NAMES.includes(name)) {
        console.error(`unknown column: ${name}`);
        process.exit(1);
      }
      if (t[0] === '+') { if (!columns.includes(name)) columns.push(name); }
      else columns = columns.filter((c) => c !== name);
    }
  } else {
    const unknown = tokens.filter((t) => !configLib.COLUMN_NAMES.includes(t));
    if (unknown.length) {
      console.error(`unknown column(s): ${unknown.join(', ')}`);
      process.exit(1);
    }
    columns = tokens;
  }

  raw.columns = columns;
  backupAndWrite(raw);
  console.log(`columns : ${columns.join(', ')}`);
} else {
  console.error(`unknown command: ${command}`);
  console.error('usage: show | set <key> <value> | columns [+x -y | a,b,c] | defaults');
  process.exit(1);
}
