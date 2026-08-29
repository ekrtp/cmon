// Terminal text measurement and layout. Kept apart from the renderer so the
// tricky parts — wide characters and wrapping — can be tested directly.

const ANSI = /\x1b\[[0-9;]*m/g;

// Cell width, not character count: ANSI escapes are invisible, and emoji/CJK
// occupy two cells. Getting this wrong shifts every column to the right of a
// Turkish or emoji title.
function width(s) {
  let n = 0;
  for (const ch of String(s == null ? '' : s).replace(ANSI, '')) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf);
    n += wide ? 2 : 1;
  }
  return n;
}

function clip(s, max) {
  s = String(s == null ? '' : s);
  if (width(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

function pad(s, max) {
  const c = clip(s, max);
  return c + ' '.repeat(Math.max(0, max - width(c)));
}

// Break text across at most `maxLines` lines of `max` cells, on word boundaries
// where one is available. The final line is ellipsized if text remains; a single
// word longer than the column is split hard rather than dropped.
function wrap(text, max, maxLines) {
  const s = String(text == null ? '' : text).trim();
  if (maxLines <= 1 || width(s) <= max) return [clip(s, max)];

  const out = [];
  let rest = s;
  while (rest && out.length < maxLines) {
    if (width(rest) <= max) { out.push(rest); rest = ''; break; }
    if (out.length === maxLines - 1) { out.push(clip(rest, max)); rest = ''; break; }

    let take = '';
    for (const ch of rest) {
      if (width(take + ch) > max) break;
      take += ch;
    }
    // If the text continues with a space, `take` already ends on a word
    // boundary — backing up to the previous space would waste a whole word.
    const endsCleanly = rest.length === take.length || /\s/.test(rest[take.length]);
    if (!endsCleanly) {
      const cut = take.lastIndexOf(' ');
      // Only honour a word break that is not absurdly early in the line.
      if (cut > max * 0.4) take = take.slice(0, cut);
    }
    out.push(take.trimEnd());
    rest = rest.slice(take.length).replace(/^\s+/, '');
  }
  return out;
}

function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function compactNumber(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

module.exports = { width, clip, pad, wrap, ago, compactNumber, ANSI };
