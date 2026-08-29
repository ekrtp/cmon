#!/usr/bin/env node
// Render the board to an SVG so the README can show real colour.
//
//   node scripts/screenshot.js                    dark + light pair into assets/
//   node scripts/screenshot.js --theme=nord       one theme
//   node scripts/screenshot.js --width=132
//
// It runs `monitor.js --once --demo`, so the picture is built from FABRICATED
// sessions (lib/demo.js) — never from whatever happens to be open on this
// machine. Then it parses the ANSI colours and writes them out as <tspan>s.
//
// SVG rather than PNG: it stays sharp, it is a few KB, it diffs as text, and it
// needs no image tooling.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const themes = require('../lib/themes');
const identity = require('../lib/identity');

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const WIDTH = Number(value('width', 132));
const OUT_DIR = path.resolve(__dirname, '..', 'assets');
const MONITOR = path.resolve(__dirname, '..', 'monitor.js');

// Type metrics for the font stack below, at 13px.
const CHAR_W = 7.82;
const LINE_H = 20;
const PAD_X = 18;
const PAD_Y = 16;

function capture(theme) {
  return execFileSync(process.execPath, [
    MONITOR, '--once', '--demo', '--no-animation', `--theme=${theme}`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: String(WIDTH), NO_COLOR: '' },
  });
}

// ANSI -> [{ text, fill, bold }]
function parse(line) {
  const spans = [];
  let fill = null;
  let bold = false;
  let back = null;
  let buffer = '';

  const flush = () => {
    if (buffer) spans.push({ text: buffer, fill, bold, back });
    buffer = '';
  };

  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    buffer += line.slice(last, m.index);
    last = m.index + m[0].length;
    flush();

    const codes = m[1].split(';').filter((c) => c !== '');
    if (!codes.length || codes[0] === '0') { fill = null; bold = false; back = null; continue; }
    if (codes[0] === '1') { bold = true; continue; }
    if (codes[0] === '38' && codes[1] === '2') {
      fill = `rgb(${codes[2]},${codes[3]},${codes[4]})`;
    }
    // Background: the zebra stripe. Recorded per line and drawn as a band.
    if (codes[0] === '48' && codes[1] === '2') {
      back = `rgb(${codes[2]},${codes[3]},${codes[4]})`;
    }
  }
  buffer += line.slice(last);
  flush();
  return spans;
}

// Belt and braces: whatever the board printed, no home directory or user name
// reaches an image that goes into a public README.
const os = require('os');
function deIdentify(text) {
  const home = os.homedir();
  return String(text)
    .split(home).join('~')
    .split(path.basename(home)).join('you');
}

const escapeXml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSvg(rawAnsi, themeName) {
  const ansi = deIdentify(rawAnsi);
  const colours = themes.resolve(themeName).colours;
  const light = identity.luminance(themes.hexToRgb(colours.header)) < 0.5;
  const background = colours.bg || (light ? '#f6f5f2' : '#0f1116');
  const defaultText = colours.header || (light ? '#1f2328' : '#c9d1d9');

  const lines = ansi.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const columns = Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
  const w = Math.round(columns * CHAR_W + PAD_X * 2);
  const h = Math.round(lines.length * LINE_H + PAD_Y * 2 + 26);

  // Zebra bands first, so the text sits on top of them.
  const bands = lines.map((line, i) => {
    const band = parse(line).find((s) => s.back);
    if (!band) return '';
    const y = PAD_Y + 26 + i * LINE_H - 14;
    return `<rect x="0" y="${y}" width="${w}" height="${LINE_H}" fill="${band.back}"/>`;
  }).filter(Boolean).join('\n  ');

  const body = lines.map((line, i) => {
    const y = PAD_Y + 26 + i * LINE_H;
    let x = PAD_X;
    const spans = parse(line).map((s) => {
      const at = x;
      x += s.text.length * CHAR_W;
      if (!s.text.trim()) return '';
      return `<tspan x="${at.toFixed(1)}" y="${y}"` +
        `${s.fill ? ` fill="${s.fill}"` : ''}` +
        `${s.bold ? ' font-weight="600"' : ''}>${escapeXml(s.text)}</tspan>`;
    }).join('');
    return spans;
  }).join('\n    ');

  // A window chrome strip, so the picture reads as a terminal at a glance.
  const dot = (cx, colour) => `<circle cx="${cx}" cy="18" r="5.5" fill="${colour}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace" font-size="13">
  <rect width="${w}" height="${h}" rx="10" fill="${background}"/>
  <rect width="${w}" height="37" rx="10" fill="${light ? '#e8e6e1' : '#1a1d24'}"/>
  <rect y="27" width="${w}" height="10" fill="${light ? '#e8e6e1' : '#1a1d24'}"/>
  ${bands}
  ${dot(22, '#ff5f57')}${dot(42, '#febc2e')}${dot(62, '#28c840')}
  <text x="${w / 2}" y="22" text-anchor="middle" font-size="11" fill="${colours.dim || '#8a8a8a'}">cmon — theme ${themeName}</text>
  <text xml:space="preserve" fill="${defaultText}">
    ${body}
  </text>
</svg>
`;
}

function write(themeName, file) {
  const svg = toSvg(capture(themeName), themeName);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, file);
  fs.writeFileSync(out, svg, 'utf8');
  console.log(`${out}  (${(svg.length / 1024).toFixed(1)} KB, theme ${themeName})`);
}

// The theme gallery is `--themes`, captured the same way.
function writeGallery() {
  const ansi = execFileSync(process.execPath, [MONITOR, '--themes'], {
    encoding: 'utf8', env: { ...process.env, COLUMNS: '110', NO_COLOR: '' },
  });
  const svg = toSvg(ansi, 'cswap');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'themes.svg');
  fs.writeFileSync(out, svg, 'utf8');
  console.log(`${out}  (${(svg.length / 1024).toFixed(1)} KB, theme gallery)`);
}

const only = value('theme', null);
if (only) {
  write(only, `monitor-${only}.svg`);
} else {
  write('cswap', 'monitor-dark.svg');
  write('cswap-light', 'monitor-light.svg');
  writeGallery();
}
