// Cost from the transcripts themselves: main session + every sub-agent and
// workflow agent under <session>/subagents/.
//
// Every assistant line carries message.usage. One API message is written as
// several lines (one per content block) with the same message.id, so usage is
// kept per id (last write wins) and summed — counting lines would double it.
//
// Files are read incrementally from the last offset, so a 50 MB transcript is
// read once and then only its new tail. A file that shrank was rewritten:
// start over. Read only. Never throws. No dependencies.

const fs = require('fs');
const path = require('path');
const { priceFor } = require('./prices');

const files = new Map();   // path -> { offset, partial, msgs: Map(id -> {cost, tokens}), unpriced: Set, seenAt }
const dirs = new Map();    // dir  -> { at, list }
const DIR_TTL_MS = 5000;
const FORGET_MS = 30 * 60000;
let lastSweep = 0;

function lineCost(u, model) {
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null
    ? cc.ephemeral_5m_input_tokens
    : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0, read = u.cache_read_input_tokens || 0;
  const tokens = inTok + outTok + read + w5m + w1h;
  const p = priceFor(model);
  if (!p) return { cost: 0, tokens, priced: false };
  // ponytail: fast mode billed as a flat 2x on every component; split it if fast-mode cache pricing ever differs.
  const k = u.speed === 'fast' ? 2 : 1;
  const cost = k * (inTok * p.input + outTok * p.output + read * p.cacheRead + w5m * p.write5m + w1h * p.write1h) / 1e6;
  return { cost, tokens, priced: true };
}

function read(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  let f = files.get(file);
  if (!f || st.size < f.offset) {
    f = { offset: 0, partial: '', msgs: new Map(), unpriced: new Set() };
    files.set(file, f);
  }
  f.seenAt = Date.now();
  if (st.size === f.offset) return f;

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - f.offset);
    fs.readSync(fd, buf, 0, buf.length, f.offset);
    f.offset = st.size;
    const lines = (f.partial + buf.toString('utf8')).split('\n');
    f.partial = lines.pop();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch (e) { continue; }
      const m = d && d.message;
      if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
      const c = lineCost(m.usage, m.model);
      if (!c.priced) f.unpriced.add(m.model);
      f.msgs.set(m.id || d.requestId || d.uuid, c);
    }
  } catch (e) {
    /* a file mid-write or locked: keep what we have, retry next refresh */
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
  return f;
}

function sum(fileList) {
  const out = { cost: 0, tokens: 0, unpriced: [] };
  const unpriced = new Set();
  for (const file of fileList) {
    const f = read(file);
    if (!f) continue;
    for (const c of f.msgs.values()) { out.cost += c.cost; out.tokens += c.tokens; }
    for (const m of f.unpriced) unpriced.add(m);
  }
  out.unpriced = [...unpriced];
  return out;
}

// Every *.jsonl under dir, recursively; listing cached for DIR_TTL_MS.
function jsonlUnder(dir) {
  const hit = dirs.get(dir);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.list;
  const list = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') list.push(p);
    }
  };
  walk(dir);
  dirs.set(dir, { at: Date.now(), list });
  return list;
}

function sweep() {
  lastSweep = Date.now();
  for (const [k, f] of files) if (Date.now() - f.seenAt > FORGET_MS) files.delete(k);
  for (const [k, d] of dirs) if (Date.now() - d.at > FORGET_MS) dirs.delete(k);
}

// { cost, tokens, unpriced, agentsCost } for one session; null without a transcript.
function forSession(sessionId, jsonlPath) {
  if (!jsonlPath) return null;
  if (Date.now() - lastSweep > FORGET_MS) sweep();
  const main = sum([jsonlPath]);
  const sub = sum(jsonlUnder(path.join(path.dirname(jsonlPath), sessionId, 'subagents')));
  return {
    cost: main.cost + sub.cost,
    tokens: main.tokens + sub.tokens,
    agentsCost: sub.cost,
    unpriced: [...new Set([...main.unpriced, ...sub.unpriced])],
  };
}

// Cost of one workflow run: its agent transcripts.
function forRun(jsonlPath, sessionId, runId) {
  if (!jsonlPath || !runId) return 0;
  return sum(jsonlUnder(path.join(path.dirname(jsonlPath), sessionId, 'subagents', 'workflows', runId))).cost;
}

module.exports = { forSession, forRun, lineCost, _files: files };
