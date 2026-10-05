// What a session last said and did, for the web board — and the sessions that
// are no longer open.
//
//   info(jsonl)   { lastPrompt, reply, replyAt, activity: [{ name, detail, at }], startedAt, cwd }
//                 from the transcript's last 256 KB and first 16 KB, cached on (mtime, size).
//                 `last-prompt` lines carry the prompt as typed; when there is none, the
//                 newest plain user turn is used (tool results, isMeta and <tag> turns skipped).
//   closed(live)  transcripts touched within the window whose session is not in the
//                 registry any more: the tabs you closed, newest first.
//
// Read only. Never throws. No dependencies.

const fs = require('fs');
const path = require('path');
const jsonl = require('./jsonl');
const titles = require('./titles');

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;
const ACTIVITY = 8;
const REPLY_CHARS = 700;
const LIST_TTL_MS = 30000;

const cache = new Map();   // jsonl -> { key, value }
let listCache = { at: 0, files: [] };

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const ms = (ts) => (ts ? Date.parse(ts) || 0 : 0);

// One short line per tool call: what you would want to see in a feed.
function describe(name, input) {
  const i = input || {};
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  let label = name;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) label = `${mcp[1].replace(/^plugin_[^_]+_/, '')} › ${mcp[2]}`;
  let detail = '';
  if (name === 'Bash' || name === 'PowerShell') detail = i.description || i.command;
  else if (/^(Read|Edit|Write|NotebookEdit)$/.test(name)) detail = base(i.file_path || i.notebook_path);
  else if (name === 'Grep' || name === 'Glob') detail = i.pattern;
  else if (name === 'Agent' || name === 'Task') detail = i.description || i.subagent_type;
  else if (name === 'Workflow') detail = 'workflow script';
  else if (name === 'Skill') detail = i.skill;
  else if (name === 'WebFetch') detail = i.url;
  else if (name === 'WebSearch') detail = i.query;
  else detail = i.description || i.action || i.query || i.url || i.file_path || '';
  return { name: label, detail: clip(detail, 120) };
}

function promptText(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return '';
  const c = d.message && d.message.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) && c.every((b) => b && b.type === 'text') ? c.map((b) => b.text).join(' ') : '';
  const t = text.trim();
  return !t || t.startsWith('<') || t.startsWith('[Request interrupted') ? '' : t;
}

function read(file) {
  const out = { lastPrompt: '', lastPromptAt: 0, reply: '', replyAt: 0, activity: [], startedAt: 0, cwd: '' };
  let edges;
  try { edges = jsonl.readEdges(file, HEAD_BYTES, TAIL_BYTES); } catch (e) { return out; }
  for (const line of edges.head) {
    const d = jsonl.parse(line);
    if (!d) continue;
    if (!out.startedAt && d.timestamp) out.startedAt = ms(d.timestamp);
    if (!out.cwd && d.cwd) out.cwd = d.cwd;
    if (out.startedAt && out.cwd) break;
  }
  const lines = edges.tail.length ? edges.tail : edges.head;
  let typed = '';
  for (let k = lines.length - 1; k >= 0; k--) {
    const d = jsonl.parse(lines[k]);
    if (!d) continue;
    if (!typed && d.type === 'last-prompt' && d.lastPrompt) typed = d.lastPrompt;
    if (!out.cwd && d.cwd) out.cwd = d.cwd;
    const p = !out.lastPromptAt && promptText(d);
    if (p) { out.lastPromptAt = ms(d.timestamp); if (!typed) typed = p; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const blocks = (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const blk = blocks[b];
      if (!out.reply && blk.type === 'text' && blk.text && blk.text.trim()) {
        // Markdown emphasis and headings read as noise in a two-line preview.
        out.reply = clip(blk.text.replace(/\*\*|__|^#+\s*/gm, ''), REPLY_CHARS);
        out.replyAt = ms(d.timestamp);
      }
      if (blk.type === 'tool_use' && out.activity.length < ACTIVITY) {
        out.activity.push({ ...describe(blk.name, blk.input), at: ms(d.timestamp) });
      }
    }
    if (out.reply && out.activity.length >= ACTIVITY && out.lastPromptAt) break;
  }
  out.lastPrompt = clip(typed, 400);
  return out;
}

function info(file) {
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = read(file);
  cache.set(file, { key, value });
  return value;
}

// Every top-level transcript touched within windowMs, newest first.
function recentFiles(windowMs) {
  if (Date.now() - listCache.at < LIST_TTL_MS) return listCache.files;
  const files = [];
  const now = Date.now();
  // Plugins that run `claude -p` from a folder under ~/.claude (measured:
  // double-shot-latte's stop-hook judge) leave a transcript per run. Not tabs.
  const own = titles.encodePath(path.join(require('os').homedir(), '.claude')).toLowerCase();
  try {
    for (const d of fs.readdirSync(titles.PROJECTS_DIR)) {
      if (d.toLowerCase().startsWith(own)) continue;
      const dir = path.join(titles.PROJECTS_DIR, d);
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const p = path.join(dir, n);
        try {
          const st = fs.statSync(p);
          // ponytail: 2 KB floor drops empty tabs; a real one-line chat is larger.
          if (now - st.mtimeMs < windowMs && st.size > 2048) files.push({ p, sessionId: n.slice(0, -6), mtimeMs: st.mtimeMs });
        } catch (e) { /* vanished */ }
      }
    }
  } catch (e) { /* no projects dir */ }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  listCache = { at: now, files };
  return files;
}

function closed(liveIds, opts) {
  const o = opts || {};
  const list = recentFiles(o.windowMs || 3 * 86400000).filter((f) => !liveIds.has(f.sessionId)).slice(0, o.limit || 40);
  return list.map((f) => {
    const t = titles.resolve(f.sessionId, null);
    const i = info(f.p) || {};
    return {
      sessionId: f.sessionId, title: t.title, lastEvent: f.mtimeMs, jsonl: f.p,
      cwd: i.cwd || '', lastPrompt: i.lastPrompt || '', reply: i.reply || '', startedAt: i.startedAt || 0,
    };
  });
}

module.exports = { info, closed, describe };
