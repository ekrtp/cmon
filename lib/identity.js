// A stable visual identity for a name.
//
// Two rows tagged `billing-api` should look like the same thing at a glance,
// without you reading either label. So every name gets a colour and a glyph
// derived from the name itself: the same project is always the same colour in
// every row, in every run, on every machine — and a different project is very
// unlikely to collide, because the hue and the glyph are drawn from different
// parts of the hash.
//
// Colour alone is not enough (NO_COLOR, `mono`, colour-blind readers), so the
// glyph carries the same information independently.

// FNV-1a: tiny, stable, and well spread for short strings.
function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const GLYPHS = {
  ascii: ['#', '*', '+', '=', '~', '%', '&', '$', '@', '?'],
  emoji: ['◆', '●', '▲', '■', '★', '◇', '○', '△', '□', '☆'],
};

function glyphFor(name, set) {
  const list = GLYPHS[set] || GLYPHS.ascii;
  // A second, independent slice of the hash, so two names that land on nearby
  // hues do not also land on the same glyph.
  return list[(hash(name) >>> 11) % list.length];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Relative luminance, used only to decide whether the theme is light or dark so
// the generated colour stays readable against it.
function luminance(rgb) {
  if (!rgb) return 0;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

// rgb for a name, tuned to the background the theme implies.
function colourFor(name, opts) {
  const o = opts || {};
  const light = !!o.light;
  const hue = hash(name) % 360;
  // Keep saturation moderate: these sit next to status colours and must not
  // outshout them.
  return hslToRgb(hue, light ? 0.55 : 0.45, light ? 0.38 : 0.68);
}

// { glyph, rgb } — everything a renderer needs for one name.
function identity(name, opts) {
  const o = opts || {};
  return {
    glyph: glyphFor(name, o.glyphs || 'ascii'),
    rgb: colourFor(name, o),
  };
}

module.exports = { identity, colourFor, glyphFor, hash, luminance, GLYPHS };
