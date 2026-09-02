// Title resolution. One public function: resolve(sessionId, cwd, opts).
//
// Priority chain (revised against the measurements in docs/DATA-SOURCES.md):
//   1. {"type":"custom-title","customTitle":"…"} — the name a person typed in
//      the IDE, NEWEST occurrence in the transcript      -> source 'user'
//   2. a curated name from another tool's database        -> source 'board'
//   3. {"type":"ai-title","aiTitle":"…"}, NEWEST          -> source 'ai-title'
//   4. first NON-META user message                        -> source 'first-prompt'
//   5. firstPrompt recorded by a hook, if any             -> source 'hook'
//   6. project name + short session id                    -> source 'fallback'
//
// Step 1 is why renaming a session in the IDE now shows up. Measured on this
// machine over 174 transcripts:
//   * the rename is written into the transcript as a `custom-title` line, and
//     re-emitted on every following turn (up to 197 copies in one file);
//   * a rename appends a NEW value rather than rewriting the old ones, so only
//     the LAST occurrence is the current title. One file carried a long
//     first-day name at its first copy and a short one at its last, four
//     hours apart (real names stay out of a public file: see demo.js);
//   * the FIRST copy sits far past any sane head window — 11,981 KB into a
//     16 MB file in the worst case — while the last sits 0–30 KB from EOF
//     in the 82 transcripts that re-emit it.
// So the live pair (`custom-title`, `ai-title`) is read from the TAIL, newest
// wins, and the tail window is 64 KB: twice the worst distance measured.
//
// 9 transcripts of 91 broke that pattern by writing the record once and never
// re-emitting it — the worst 79 KB from the start and 11,742 KB from EOF. That
// is why the head is scanned for the same two records as well; a tail hit still
// wins, being later in the file. Together the two windows return the name the
// file ends on in 91 of 91 cases: `node scripts/probe-titles.js` reproduces it.
//
// `ai-title` drifts the same way — 8 transcripts of 174 ended on a different
// value than they started with — so it is no longer cached permanently. Caching is per window instead: the tail is
// re-read whenever the file's mtime moves, while the head — immutable once the
// file has grown past 128 KB, because transcripts are append-only — is read once.
//
// Deliberately NOT in the chain:
//   - `name` in sessions/<PID>.json: nameSource is "derived" in 33/33 records
//     and the value is a generated handle ("vscode-dd"), not a title.
//   - sessions-index.json / firstPrompt: that file does not exist on this
//     machine at all (0 of 8 project directories).

const fs = require('fs');
const path = require('path');
const os = require('os');
const jsonl = require('./jsonl');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;   // measured: a re-emitted rename lands ≤30 KB from EOF
// sessionId -> { jsonl, mtimeMs, custom, ai, headDone, headCustom, headAi, first }
const cache = new Map();
// cwd -> encoded project directory name (stable, cached for the process)
const dirCache = new Map();

// Measured: "c:\Users\you\Documents\workspace" -> "c--Users-you-Documents-workspace".
// Case is preserved. We never decode in the other direction: a real hyphen in a
// folder name cannot be told apart from an encoded separator (that was
// upstream's decodeDirName bug, which turned "e-commerce" into "e\commerce").
function encodePath(abs) {
  return abs.replace(/[\\/:._]/g, '-');
}

function findTranscript(sessionId, cwd) {
  if (cwd) {
    let enc = dirCache.get(cwd);
    if (enc === undefined) {
      enc = encodePath(cwd);
      dirCache.set(cwd, enc);
    }
    const p = path.join(PROJECTS_DIR, enc, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  // Encoding did not match (rare): scan the project directories once.
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Claude Code writes IDE notifications, slash-command output and tool results as
// user turns wrapped in <tag>…</tag> and/or flagged isMeta. Without this filter
// the title becomes "Caveat: The messages below…".
function isMeta(line, text) {
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return true;
  const t = (text || '').trim();
  if (!t) return true;
  if (t[0] === '<') return true;
  if (/^Caveat: The messages below/.test(t)) return true;
  if (/^\[Request interrupted/.test(t)) return true;
  if (/^This session is being continued/.test(t)) return true;
  return false;
}

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // plain text only — tool_result blocks are not titles
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text).join(' ');
  }
  return '';
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

// Pick the last `customTitle` / `aiTitle` out of a set of lines. `seen` says a
// record of that kind was inside the window at all, which is what lets an
// emptied title clear a stale one while a record that has scrolled out of the
// window leaves the last known value alone.
function titlesIn(lines) {
  const out = { custom: '', customSeen: false, ai: '', aiSeen: false };
  for (const raw of lines) {
    // cheap reject: both keys end in "Title"
    if (raw.indexOf('Title') === -1) continue;
    const o = jsonl.parse(raw);
    if (!o) continue;
    if (typeof o.customTitle === 'string') { out.custom = collapse(o.customTitle); out.customSeen = true; }
    if (typeof o.aiTitle === 'string') { out.ai = collapse(o.aiTitle); out.aiSeen = true; }
  }
  return out;
}

// Steps 1 and 3, from the tail — where a re-emitted record lives.
function fromTail(file) {
  const { head, tail } = jsonl.readEdges(file, 0, TAIL_BYTES);
  return titlesIn(tail.length ? tail : head);
}

// Step 4, from the head — plus a second look for steps 1 and 3, because a
// rename is not always re-emitted: measured, 9 transcripts carried a single
// `custom-title` copy, the worst 79 KB in and 11,742 KB from EOF, which no tail
// window reaches. A tail hit still wins, being the later one in the file.
function fromHead(file) {
  const { head } = jsonl.readEdges(file, HEAD_BYTES, 0);
  const found = titlesIn(head);
  for (const raw of head) {
    const o = jsonl.parse(raw);
    if (!o || o.type !== 'user') continue;
    const text = textOf(o.message);
    if (isMeta(o, text)) continue;
    found.first = { title: collapse(text), source: 'first-prompt' };
    break;
  }
  return found;
}

// The whole transcript-side chain in one call. Exposed for the fixture tests;
// resolve() runs the same steps but caches each window separately.
function fromTranscript(file) {
  const tail = fromTail(file);
  if (tail.custom) return { title: tail.custom, source: 'user' };
  const head = fromHead(file);
  if (head.custom) return { title: head.custom, source: 'user' };
  const ai = tail.ai || head.ai;
  if (ai) return { title: ai, source: 'ai-title' };
  return head.first || null;
}

// opts: { hookPrompt, boardTitle } — boardTitle is a name curated in another
// tool's database (lib/ccboard.js). It sits BELOW the transcript's own
// custom-title on purpose: that database is written by a process which may not
// even be running, and measured here it was 5 days stale and still holding the
// pre-rename name, while the transcript had the current one.
function resolve(sessionId, cwd, opts) {
  if (!sessionId) return { title: null, source: 'none', mtimeMs: 0, jsonl: null };
  const o = opts && typeof opts === 'object' ? opts : { hookPrompt: opts };
  const hookPrompt = o.hookPrompt;
  const boardTitle = typeof o.boardTitle === 'string' ? o.boardTitle.trim() : '';

  const file = findTranscript(sessionId, cwd);
  let mtimeMs = 0;
  let size = 0;
  if (file) {
    try {
      const st = fs.statSync(file);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch (e) { mtimeMs = 0; size = 0; }
  }

  let e = cache.get(sessionId);
  if (!e || (file && e.jsonl !== file)) {
    e = { jsonl: file, mtimeMs: -1, custom: '', ai: '', headDone: false, headCustom: '', headAi: '', first: null };
    cache.set(sessionId, e);
  }

  // Everything is keyed on mtime: an untouched transcript costs one stat().
  if (file && e.mtimeMs !== mtimeMs) {
    e.mtimeMs = mtimeMs;
    let tail = null;
    try { tail = fromTail(file); } catch (err) { tail = null; }
    if (tail) {
      if (tail.customSeen) e.custom = tail.custom;
      if (tail.aiSeen) e.ai = tail.ai;
    }
    // A transcript is append-only, so the head window stops changing as soon as
    // the file is longer than the window: read it once and keep the answer.
    if (!e.headDone) {
      let head = null;
      try { head = fromHead(file); } catch (err) { head = null; }
      if (head) {
        e.headCustom = head.custom;
        e.headAi = head.ai;
        e.first = head.first || null;
        e.headDone = size >= HEAD_BYTES;
      }
    }
  }

  let result;
  if (e.custom) result = { title: e.custom, source: 'user' };
  else if (e.headCustom) result = { title: e.headCustom, source: 'user' };
  else if (boardTitle) result = { title: boardTitle, source: 'board' };
  else if (e.ai) result = { title: e.ai, source: 'ai-title' };
  else if (e.headAi) result = { title: e.headAi, source: 'ai-title' };
  else if (e.first) result = e.first;
  else if (hookPrompt && collapse(hookPrompt)) result = { title: collapse(hookPrompt), source: 'hook' };
  else {
    const project = cwd ? path.basename(cwd) : 'unknown';
    result = { title: `${project} · ${sessionId.slice(0, 8)}`, source: 'fallback' };
  }

  return { title: result.title, source: result.source, mtimeMs, jsonl: file };
}

module.exports = {
  resolve, encodePath, findTranscript, PROJECTS_DIR,
  // exposed for the fixture tests
  _fromTranscript: fromTranscript,
  _fromTail: fromTail,
};
