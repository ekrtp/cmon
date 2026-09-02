#!/usr/bin/env node
// Where do the two title records actually sit, and do their values change?
//
// Answers the question `lib/titles.js` is built on: renaming a session in the
// IDE writes a `custom-title` line into the transcript, so a monitor that only
// reads the head of the file — or caches the first copy it sees — shows a name
// the user changed hours ago.
//
// Prints one row per transcript: how many copies of each record, how many
// DISTINCT values, how far the first copy is from the start of the file and how
// far the last copy is from EOF. That last number is what sets TAIL_BYTES.
//
// STOP: the output quotes REAL session names. It belongs in `docs/`
// (gitignored for exactly this reason) or in a terminal - never pasted into a
// tracked file.
//
// Usage: node scripts/probe-titles.js [project-dir] [rows]
//   default project-dir: the largest directory under ~/.claude/projects

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function biggestProject() {
  let best = null;
  for (const d of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, d);
    let total = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jsonl')) total += fs.statSync(path.join(dir, f)).size;
      }
    } catch (e) { continue; }
    if (!best || total > best.total) best = { dir, total };
  }
  return best && best.dir;
}

function scan(file) {
  const size = fs.statSync(file).size;
  if (!size) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const found = { customTitle: [], aiTitle: [] };
  let off = 0;
  for (const line of lines) {
    const len = Buffer.byteLength(line) + 1;
    if (line.indexOf('Title') !== -1) {
      let o = null;
      try { o = JSON.parse(line); } catch (e) { o = null; }
      if (o) {
        for (const key of ['customTitle', 'aiTitle']) {
          if (typeof o[key] === 'string') found[key].push({ v: o[key], off });
        }
      }
    }
    off += len;
  }
  const stat = (hits) => ({
    n: hits.length,
    distinct: new Set(hits.map((h) => h.v)).size,
    firstAtKB: hits.length ? Math.round(hits[0].off / 1024) : null,
    lastFromEndKB: hits.length ? Math.round((size - hits[hits.length - 1].off) / 1024) : null,
    current: hits.length ? hits[hits.length - 1].v : '',
  });
  return { sizeKB: Math.round(size / 1024), custom: stat(found.customTitle), ai: stat(found.aiTitle) };
}

const dir = process.argv[2] || biggestProject();
const rows = Number(process.argv[3]) || 12;
if (!dir) { console.error('no project directory found'); process.exit(1); }

const results = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  let r = null;
  try { r = scan(path.join(dir, f)); } catch (e) { r = null; }
  if (r) results.push({ id: f.slice(0, 8), ...r });
}
results.sort((a, b) => b.sizeKB - a.sizeKB);

console.log(`# ${dir}\n# ${results.length} transcripts scanned in full\n`);
console.log('| transcript | size | custom-title copies / distinct | first copy at | last copy from EOF | current name |');
console.log('|---|---|---|---|---|---|');
for (const r of results.slice(0, rows)) {
  const c = r.custom;
  console.log(`| \`${r.id}…\` | ${r.sizeKB} KB | ${c.n} / ${c.distinct} | ` +
    `${c.firstAtKB === null ? '—' : c.firstAtKB + ' KB'} | ` +
    `${c.lastFromEndKB === null ? '—' : c.lastFromEndKB + ' KB'} | ${c.current || '—'} |`);
}

// Acceptance: does the chain lib/titles.js actually uses — last copy in a 64 KB
// tail, else last copy in a 128 KB head — return the name the file ends on?
const titles = require('../lib/titles');
let checked = 0, agreed = 0, missed = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const file = path.join(dir, f);
  let truth = null;
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of all) {
      if (line.indexOf('customTitle') === -1) continue;
      try {
        const o = JSON.parse(line);
        if (typeof o.customTitle === 'string') truth = o.customTitle.replace(/\s+/g, ' ').trim();
      } catch (e) { /* ignore */ }
    }
  } catch (e) { continue; }
  if (!truth) continue;
  checked++;
  let got = null;
  try {
    const r = titles._fromTranscript(file);
    got = r && r.source === 'user' ? r.title : null;
  } catch (e) { got = null; }
  if (got === truth) agreed++; else missed.push(`${f.slice(0, 8)}… want "${truth}" got ${got === null ? 'nothing' : '"' + got + '"'}`);
}

const withCustom = results.filter((r) => r.custom.n);
const renamed = withCustom.filter((r) => r.custom.distinct > 1);
const reemitted = withCustom.filter((r) => r.custom.n > 1);
const once = withCustom.filter((r) => r.custom.n === 1);
const maxFromEnd = reemitted.reduce((m, r) => Math.max(m, r.custom.lastFromEndKB), 0);
const maxFirstAt = withCustom.reduce((m, r) => Math.max(m, r.custom.firstAtKB), 0);
const onceBeyondHead = once.filter((r) => r.custom.firstAtKB * 1024 >= 128 * 1024 &&
  r.custom.lastFromEndKB * 1024 >= 64 * 1024);
const aiDrift = results.filter((r) => r.ai.distinct > 1);
console.log(`\n- transcripts with a \`custom-title\`: **${withCustom.length}** of ${results.length}`);
console.log(`- of those, renamed at least once (>1 distinct value): **${renamed.length}**`);
console.log(`- furthest the FIRST copy sits from the start: **${maxFirstAt} KB** → a head window alone cannot find it`);
console.log(`- re-emitted (>1 copy): **${reemitted.length}**, furthest LAST copy from EOF **${maxFromEnd} KB** → this sets \`TAIL_BYTES\``);
console.log(`- written once and never re-emitted: **${once.length}** → the head is scanned for these too,` +
  ` ${onceBeyondHead.length} of them out of reach of both windows`);
console.log(`- transcripts whose \`ai-title\` changed value: **${aiDrift.length}** → it cannot be cached forever either`);
console.log(`\n\`lib/titles.js\` returns the name the file ends on in **${agreed} of ${checked}** transcripts` +
  ` that carry one (64 KB tail, then 128 KB head).`);
for (const m of missed) console.log(`  - missed: ${m}`);
