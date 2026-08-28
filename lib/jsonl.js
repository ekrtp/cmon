// Shared JSONL reader. Transcripts get large (measured: largest 23.1 MB,
// average ~1.9 MB), so we never read a whole file: only the head and the tail.
//
// Do NOT shell out to grep/findstr — pure Node only. (Windows console encoding
// silently mangles matches, which is why other tools show empty titles here.)

const fs = require('fs');

// Read `headBytes` from the start and `tailBytes` from the end, dropping the
// partial lines at each cut point. Returns arrays of raw lines.
function readEdges(file, headBytes, tailBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const headLen = Math.min(headBytes, size);
    const headBuf = Buffer.alloc(headLen);
    if (headLen) fs.readSync(fd, headBuf, 0, headLen, 0);

    let tailText = '';
    let tailStart = 0;
    if (size > headLen) {
      const tailLen = Math.min(tailBytes, size - headLen);
      tailStart = size - tailLen;
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, tailStart);
      tailText = tailBuf.toString('utf8');
    }

    const head = headBuf.toString('utf8').split('\n');
    if (size > headLen) head.pop();          // last head line is truncated
    const tail = tailText ? tailText.split('\n') : [];
    // Only drop the first tail line when the window actually started mid-file.
    // With headBytes = 0 the tail begins at byte 0, so nothing is truncated;
    // shifting there swallowed the first line of every short transcript
    // (the fixture tests caught this).
    if (tail.length && tailStart > 0) tail.shift();

    return { head, tail, size };
  } finally {
    fs.closeSync(fd);
  }
}

// Parse one JSONL line. Returns null for blanks, partial writes and garbage —
// a corrupt transcript must never crash the monitor.
function parse(line) {
  const s = line.trim();
  if (!s || s[0] !== '{') return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { readEdges, parse };
