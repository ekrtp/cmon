// Which project is a session actually about?
//
// The problem: every VS Code chat in one workspace reports the same `cwd` (the
// workspace root), so grouping by directory puts everything in one bucket. What
// you want to know is which sub-project the conversation is about.
//
// How this answers it, cheaply and without guessing at content:
//   1. Walk up from the session's cwd to the nearest CLAUDE.md — that is the
//      workspace root. Take the folder names it links to (a router file lists
//      exactly the projects that exist) and fall back to the root's real
//      sub-directories when there is no CLAUDE.md.
//   2. Score those names against the session transcript: a name that appears as
//      a PATH ("project-c/veri-kesfi", "informations\\connections") counts far more
//      than a name merely mentioned in prose.
//   3. Report the winner, with its score and margin, so the UI can stay quiet
//      when the evidence is thin.
//
// This is a heuristic, and it is labelled as one: the column shows a `?` when
// the winner did not clearly beat the runner-up.

const fs = require('fs');
const path = require('path');
const jsonl = require('./jsonl');

const HEAD_BYTES = 32 * 1024;    // the opening prompt usually names the project
const TAIL_BYTES = 192 * 1024;   // what the session is on RIGHT NOW
const TTL_MS = 30000;            // focus changes slowly; no need to rescan often
const MIN_SCORE = 4;             // below this, the evidence is too thin to show
const MARGIN = 1.5;              // winner must beat the runner-up by this factor
const PER_LINE_CAP = 4;          // one enormous line must not decide everything

const IGNORED = new Set([
  'node_modules', 'dist', 'build', 'out', 'venv', '.venv', '__pycache__',
  'Archive', 'archive', '_arsiv', 'docs', 'lib', 'test', 'tests', 'scripts', 'src',
]);

const rootCache = new Map();     // cwd -> { root, candidates, at }
const focusCache = new Map();    // sessionId -> { at, mtimeMs, value }

function workspaceRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 8 && dir; i++) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

// Folder names a CLAUDE.md router links to: [`name/`](name/CLAUDE.md) and
// plain markdown links to a directory.
function fromClaudeMd(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  } catch (e) {
    return [];
  }
  const names = new Set();
  const linkRe = /\]\(([A-Za-z0-9._-]+)\/(?:CLAUDE\.md)?\)/g;
  let m;
  while ((m = linkRe.exec(text))) names.add(m[1]);
  const backtickRe = /`([A-Za-z0-9._-]+)\/`/g;
  while ((m = backtickRe.exec(text))) names.add(m[1]);
  return [...names];
}

function fromDisk(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (e) {
    return [];
  }
}

function candidatesFor(cwd) {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < 300000) return hit;

  const root = workspaceRoot(cwd);
  const listed = fromClaudeMd(root);
  const disk = fromDisk(root);
  // Union, not either/or. CLAUDE.md names the projects that matter, but a
  // router file is allowed to lag: a folder it does not mention (measured here:
  // personal-folder, deliberately untracked) is still a real place to be working.
  // Anything CLAUDE.md names that no longer exists on disk is dropped.
  const names = [...new Set([...listed.filter((n) => disk.includes(n)), ...disk])]
    .filter((n) => !IGNORED.has(n) && n.length >= 2);

  const value = {
    root,
    at: Date.now(),
    candidates: names.map((name) => ({
      name,
      // Path-shaped mention: "name/", "name\", or "/name" — strong evidence.
      pathRe: new RegExp(`[\\\\/"'\`( ]${escape(name)}[\\\\/]`, 'gi'),
      // Bare mention anywhere — weak evidence.
      wordRe: new RegExp(`(^|[^A-Za-z0-9_-])${escape(name)}([^A-Za-z0-9_-]|$)`, 'gi'),
    })),
  };
  rootCache.set(cwd, value);
  return value;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCapped(re, line) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(line) && n < PER_LINE_CAP) n++;
  return n;
}

// { name, score, runnerUp, confident } or null.
function focusOf(sessionId, cwd, transcript) {
  if (!sessionId || !cwd || !transcript) return null;

  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(transcript).mtimeMs; } catch (e) { return null; }

  const hit = focusCache.get(sessionId);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < TTL_MS) return hit.value;

  const { candidates } = candidatesFor(cwd);
  if (!candidates.length) return null;

  let head = [], tail = [];
  try {
    const edges = jsonl.readEdges(transcript, HEAD_BYTES, TAIL_BYTES);
    head = edges.head;
    tail = edges.tail;
  } catch (e) {
    return null;
  }

  // What the session is doing NOW outweighs how it opened: a long conversation
  // drifts, and the opening prompt keeps voting for a project left behind hours
  // ago. The tail therefore counts double.
  const scores = new Map();
  const scan = (lines, weight) => {
    for (const line of lines) {
      if (!line) continue;
      const lower = line.toLowerCase();
      for (const c of candidates) {
        if (lower.indexOf(c.name.toLowerCase()) === -1) continue;   // cheap reject
        const asPath = countCapped(c.pathRe, line);
        const asWord = countCapped(c.wordRe, line);
        const add = (asPath * 3 + Math.max(0, asWord - asPath)) * weight;
        if (add) scores.set(c.name, (scores.get(c.name) || 0) + add);
      }
    }
  };
  scan(head, 1);
  scan(tail, 2);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  let value = null;
  if (ranked.length && ranked[0][1] >= MIN_SCORE) {
    const [name, score] = ranked[0];
    const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;
    value = { name, score, runnerUp, confident: score >= runnerUp * MARGIN };
  }

  focusCache.set(sessionId, { at: Date.now(), mtimeMs, value });
  return value;
}

module.exports = { focusOf, candidatesFor, workspaceRoot, MIN_SCORE };
