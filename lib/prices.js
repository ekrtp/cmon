// $ per million tokens, first-party API rates (claude-api skill, cached 2026-09-25).
// Cache writes follow the standard multipliers: 5-minute = 1.25x input, 1-hour = 2x.
//
// Why here and not dashboard.db: that table stopped being updated on 2026-08-28 and
// never had a claude-opus-5 row, so ~94% of the spend was being counted as $0.
// A model missing from this list still counts its tokens; only its cost is unknown
// (cost.js reports it in `unpriced`).
//
// Longest matching prefix wins, so "claude-opus-5-5" beats "claude-opus-5".

const PRICES = [
  // prefix                input  output cacheRead write5m write1h
  ['claude-fable-5-1',     10,    50,    0.25,     12.5,   20],
  ['claude-fable-5',       10,    50,    1,        12.5,   20],
  ['claude-mythos-5',      10,    50,    1,        12.5,   20],
  ['claude-opus-5-5',      4,     20,    0.2,      5,      8],
  ['claude-opus-5',        5,     25,    0.5,      6.25,   10],
  ['claude-opus-4-8',      5,     25,    0.5,      6.25,   10],
  ['claude-opus-4-7',      5,     25,    0.5,      6.25,   10],
  ['claude-opus-4-6',      5,     25,    0.5,      6.25,   10],
  ['claude-opus-4-5',      5,     25,    0.5,      6.25,   10],
  ['claude-opus-4',        15,    75,    1.5,      18.75,  30],
  ['claude-sonnet-5',      2,     10,    0.2,      2.5,    4],
  ['claude-sonnet-4',      3,     15,    0.3,      3.75,   6],
  ['claude-haiku-4-5',     1,     5,     0.1,      1.25,   2],
].map(([prefix, input, output, cacheRead, write5m, write1h]) => ({ prefix, input, output, cacheRead, write5m, write1h }));

function priceFor(model) {
  const m = String(model || '');
  let best = null;
  for (const p of PRICES) {
    if (m.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

module.exports = { priceFor, PRICES };
