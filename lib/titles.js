// Title resolution. One public function: resolve(sessionId, cwd, hookPrompt).
//
// Priority chain (revised against the measurements in docs/DATA-SOURCES.md):
//   1. a name a person gave the session (lib/ccboard.js)      -> source 'user'
//   2. {"type":"ai-title","aiTitle":"…"} in the transcript    -> source 'ai-title'
//   3. first NON-META user message                            -> source 'first-prompt'
//   4. firstPrompt recorded by a hook, if any                 -> source 'hook'
//   5. project name + short session id                        -> source 'fallback'
//
// Step 1 is why renaming a session now shows up: the name lives in another
// tool's database, never in Claude Code's own files.
//
// Deliberately NOT in the chain:
//   - `name` in sessions/<PID>.json: nameSource is "derived" in 33/33 records
//     and the value is a generated handle ("vscode-dd"), not a title.
//   - sessions-index.json / firstPrompt: that file does not exist on this
//     machine at all (0 of 8 project directories).
//
// Measured: the ai-title line sits at line 11 but BEYOND the first 8 KB, because
// transcript lines are long. An 8 KB head missed it and fell back to the first
// prompt, so the head window is 128 KB. The cost is paid once: a resolved
// ai-title is cached permanently, even as the transcript keeps growing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const jsonl = require('./jsonl');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 16 * 1024;
const RETRY_MS = 15000;   // how often to re-attempt a weak/missing title

// sessionId -> { title, source, mtimeMs, jsonl, lastTry }
const cache = new Map();
// cwd -> encoded project directory name (stable, cached for the process)
const dirCache = new Map();

// Measured: "c:\Users\…\Documents\VSCode" -> "c--Users-…-Documents-VSCode".
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

// Apply steps 1-2 of the chain to a transcript file.
function fromTranscript(file) {
  const { head, tail } = jsonl.readEdges(file, HEAD_BYTES, TAIL_BYTES);

  // 1. ai-title. Measured at the head, but a resumed session can append one, so
  //    both edges are checked.
  for (const group of [head, tail]) {
    for (const raw of group) {
      if (raw.indexOf('ai-title') === -1 && raw.indexOf('aiTitle') === -1) continue;
      const o = jsonl.parse(raw);
      if (o && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        return { title: o.aiTitle.trim(), source: 'ai-title' };
      }
    }
  }

  // 2. first non-meta user message
  for (const raw of head) {
    const o = jsonl.parse(raw);
    if (!o || o.type !== 'user') continue;
    const text = textOf(o.message);
    if (isMeta(o, text)) continue;
    return { title: text.replace(/\s+/g, ' ').trim(), source: 'first-prompt' };
  }

  return null;
}

// opts: { hookPrompt, userTitle } — userTitle outranks everything, because a
// person typed it on purpose.
function resolve(sessionId, cwd, opts) {
  if (!sessionId) return { title: null, source: 'none', mtimeMs: 0, jsonl: null };
  const o = opts && typeof opts === 'object' ? opts : { hookPrompt: opts };
  const hookPrompt = o.hookPrompt;
  const userTitle = typeof o.userTitle === 'string' ? o.userTitle.trim() : '';

  const file = findTranscript(sessionId, cwd);
  let mtimeMs = 0;
  if (file) {
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { mtimeMs = 0; }
  }

  // A human-given name is never cached against the transcript: it can change at
  // any moment in the other tool, and it costs nothing to prefer it.
  if (userTitle) {
    return { title: userTitle, source: 'user', mtimeMs, jsonl: file };
  }

  const prev = cache.get(sessionId);
  if (prev && prev.jsonl === file) {
    // A resolved ai-title never needs re-reading, however much the file grows.
    if (prev.source === 'ai-title') {
      return { title: prev.title, source: prev.source, mtimeMs, jsonl: file };
    }
    // Weak titles are retried, but at most every RETRY_MS.
    const recentlyTried = Date.now() - (prev.lastTry || 0) < RETRY_MS;
    if (prev.title && (prev.mtimeMs === mtimeMs || recentlyTried)) {
      return { title: prev.title, source: prev.source, mtimeMs, jsonl: file };
    }
  }

  let result = null;
  if (file) {
    try { result = fromTranscript(file); } catch (e) { result = null; }
  }

  if (!result && hookPrompt && String(hookPrompt).trim()) {
    result = { title: String(hookPrompt).replace(/\s+/g, ' ').trim(), source: 'hook' };
  }

  if (!result) {
    const project = cwd ? path.basename(cwd) : 'unknown';
    result = { title: `${project} · ${sessionId.slice(0, 8)}`, source: 'fallback' };
  }

  cache.set(sessionId, { ...result, mtimeMs, jsonl: file, lastTry: Date.now() });
  return { ...result, mtimeMs, jsonl: file };
}

module.exports = {
  resolve, encodePath, findTranscript, PROJECTS_DIR,
  // exposed for the fixture tests
  _fromTranscript: fromTranscript,
};
