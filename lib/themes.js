// Themes. Every theme maps a status (and a few chrome roles) to a hex colour;
// the renderer converts to ANSI truecolour.
//
// Colour contract:
//   done        -> green   (turn finished, nothing waiting on Claude)
//   asking      -> yellow  (Claude needs you: a question or a permission)
//   interrupted -> red/amber (you stopped it)
//   running     -> the theme's signature colour (a tool is executing)
//   thinking    -> a second, quieter accent (model is generating)
//   idle        -> grey
//
// Drop your own as ~/.claude/monitor/themes/<name>.json with the same keys and
// set "theme": "<name>". Missing keys fall back to `dark`.

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_THEME_DIR = path.join(os.homedir(), '.claude', 'monitor', 'themes');

const BUILT_IN = {
  // Tokyo Night register — the fork's default.
  dark: {
    running: '#7aa2f7', thinking: '#bb9af7', done: '#9ece6a',
    asking: '#e0af68', interrupted: '#f7768e', idle: '#565f89',
    header: '#c0caf5', dim: '#565f89', accent: '#e0af68', border: '#3b4261', bg: '#1a1b26',
  },
  light: {
    running: '#2f6fd0', thinking: '#7b4bc0', done: '#2e7d32',
    asking: '#b26a00', interrupted: '#c62828', idle: '#8a8f98',
    header: '#1f2430', dim: '#8a8f98', accent: '#b26a00', border: '#cfd4dc', bg: '#fbfbfd',
  },

  // Adapted from claude-swap's own TUI theme (claude_swap/tui/theme.py):
  // ACCENT #d7875f is its warm terracotta (xterm 173), with the desaturated
  // severity ramp SEV_OK / SEV_WARN / SEV_CRIT and TRACK as the border.
  // `thinking` has no counterpart there, so it uses a dimmed accent.
  cswap: {
    running: '#d7875f', thinking: '#b08968', done: '#87af87',
    asking: '#d7af5f', interrupted: '#d75f5f', idle: '#8a8a8a',
    header: '#e8e4de', dim: '#6a6a6a', accent: '#d7875f', border: '#3a3a3a', bg: '#141414',
  },
  // Its light companion (ACCENT_LIGHT #954c2a and the deepened severity ramp).
  'cswap-light': {
    running: '#954c2a', thinking: '#8a6244', done: '#3d6b3d',
    asking: '#795911', interrupted: '#ad3128', idle: '#635d55',
    header: '#2b2723', dim: '#7d766c', accent: '#954c2a', border: '#cec7ba', bg: '#faf7f2',
  },

  solarized: {
    running: '#268bd2', thinking: '#6c71c4', done: '#859900',
    asking: '#b58900', interrupted: '#cb4b16', idle: '#586e75',
    header: '#93a1a1', dim: '#586e75', accent: '#b58900', border: '#073642', bg: '#002b36',
  },
  'solarized-light': {
    running: '#268bd2', thinking: '#6c71c4', done: '#657b00',
    asking: '#b58900', interrupted: '#cb4b16', idle: '#93a1a1',
    header: '#586e75', dim: '#93a1a1', accent: '#b58900', border: '#eee8d5', bg: '#fdf6e3',
  },
  nord: {
    running: '#88c0d0', thinking: '#b48ead', done: '#a3be8c',
    asking: '#ebcb8b', interrupted: '#bf616a', idle: '#4c566a',
    header: '#e5e9f0', dim: '#616e88', accent: '#88c0d0', border: '#3b4252', bg: '#2e3440',
  },
  gruvbox: {
    running: '#83a598', thinking: '#d3869b', done: '#b8bb26',
    asking: '#fabd2f', interrupted: '#fb4934', idle: '#665c54',
    header: '#ebdbb2', dim: '#7c6f64', accent: '#fe8019', border: '#3c3836', bg: '#282828',
  },
  dracula: {
    running: '#8be9fd', thinking: '#bd93f9', done: '#50fa7b',
    asking: '#f1fa8c', interrupted: '#ff5555', idle: '#6272a4',
    header: '#f8f8f2', dim: '#6272a4', accent: '#ff79c6', border: '#44475a', bg: '#282a36',
  },
  catppuccin: {
    running: '#89b4fa', thinking: '#cba6f7', done: '#a6e3a1',
    asking: '#f9e2af', interrupted: '#f38ba8', idle: '#6c7086',
    header: '#cdd6f4', dim: '#6c7086', accent: '#f5c2e7', border: '#45475a', bg: '#1e1e2e',
  },
  'catppuccin-latte': {
    running: '#1e66f5', thinking: '#8839ef', done: '#40a02b',
    asking: '#df8e1d', interrupted: '#d20f39', idle: '#9ca0b0',
    header: '#4c4f69', dim: '#9ca0b0', accent: '#ea76cb', border: '#ccd0da', bg: '#eff1f5',
  },
  'one-dark': {
    running: '#61afef', thinking: '#c678dd', done: '#98c379',
    asking: '#e5c07b', interrupted: '#e06c75', idle: '#5c6370',
    header: '#abb2bf', dim: '#5c6370', accent: '#d19a66', border: '#3e4451', bg: '#282c34',
  },
  'rose-pine': {
    running: '#9ccfd8', thinking: '#c4a7e7', done: '#31748f',
    asking: '#f6c177', interrupted: '#eb6f92', idle: '#6e6a86',
    header: '#e0def4', dim: '#6e6a86', accent: '#ebbcba', border: '#26233a', bg: '#191724',
  },
  ayu: {
    running: '#59c2ff', thinking: '#d2a6ff', done: '#aad94c',
    asking: '#ffb454', interrupted: '#f07178', idle: '#5c6773',
    header: '#bfbdb6', dim: '#5c6773', accent: '#ffb454', border: '#1f2430', bg: '#0b0e14',
  },
  monokai: {
    running: '#66d9ef', thinking: '#ae81ff', done: '#a6e22e',
    asking: '#e6db74', interrupted: '#f92672', idle: '#75715e',
    header: '#f8f8f2', dim: '#75715e', accent: '#fd971f', border: '#49483e', bg: '#272822',
  },
  'github-light': {
    running: '#0969da', thinking: '#8250df', done: '#1a7f37',
    asking: '#9a6700', interrupted: '#cf222e', idle: '#8c959f',
    header: '#1f2328', dim: '#8c959f', accent: '#bc4c00', border: '#d0d7de', bg: '#ffffff',
  },
  // No colour at all: the glyphs still separate the statuses.
  mono: {
    running: null, thinking: null, done: null,
    asking: null, interrupted: null, idle: null,
    header: null, dim: null, accent: null, border: null,
    // `bg` only matters to the SVG screenshotter; null lets it pick a default.
    bg: null,
  },
};

const REQUIRED_KEYS = Object.keys(BUILT_IN.dark);

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function listUserThemes() {
  try {
    return fs.readdirSync(USER_THEME_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json'));
  } catch (e) {
    return [];
  }
}

function loadUserTheme(name) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(USER_THEME_DIR, name + '.json'), 'utf8'));
    return { ...BUILT_IN.dark, ...raw };   // a partial theme still renders
  } catch (e) {
    return null;
  }
}

// Never throws; always returns something renderable.
function resolve(name) {
  const wanted = String(name || 'dark');
  const theme = BUILT_IN[wanted] || loadUserTheme(wanted);
  if (!theme) {
    return { name: 'dark', colours: BUILT_IN.dark, fallbackFrom: wanted, missing: [] };
  }
  return { name: wanted, colours: theme, missing: REQUIRED_KEYS.filter((k) => !(k in theme)) };
}

function names() {
  return [...Object.keys(BUILT_IN), ...listUserThemes()];
}

// Blend two hex colours. Used for the context ramp, where a hard threshold
// ("70% is amber") hides the difference between 71% and 89%.
function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return x ? a : b;
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(x[0] + (y[0] - x[0]) * k),
    Math.round(x[1] + (y[1] - x[1]) * k),
    Math.round(x[2] + (y[2] - x[2]) * k),
  ];
}

// A continuous green -> amber -> red ramp built from the theme's own colours,
// so every theme gets a ramp that belongs to it. ratio is 0..1 (context full).
// Below QUIET the value is not worth shouting about, so it stays in `dim`.
const RAMP_QUIET = 0.35;
function ramp(colours, ratio) {
  if (!colours.done || !colours.asking || !colours.interrupted) return null;  // mono
  const r = Math.max(0, Math.min(1, ratio));
  if (r <= RAMP_QUIET) return hexToRgb(colours.dim) || hexToRgb(colours.done);
  if (r <= 0.75) return mix(colours.done, colours.asking, (r - RAMP_QUIET) / (0.75 - RAMP_QUIET));
  return mix(colours.asking, colours.interrupted, (r - 0.75) / 0.25);
}

module.exports = { resolve, names, hexToRgb, mix, ramp, RAMP_QUIET, BUILT_IN, REQUIRED_KEYS, USER_THEME_DIR };
