// Themes. Every theme maps a status (and a few chrome roles) to a hex colour;
// we convert to ANSI truecolour at render time.
//
// Colour contract the user asked for:
//   done        -> green   (turn finished, nothing waiting on Claude)
//   asking      -> yellow  (Claude needs you: question or permission prompt)
//   interrupted -> yellow  (you stopped it mid-flight)
//   running     -> blue    (a tool is executing)
//   thinking    -> purple  (model is generating)
//   idle        -> grey    (nothing happening)
//
// Drop your own theme as ~/.claude/monitor/themes/<name>.json with the same
// keys and set "theme": "<name>" in the config.

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_THEME_DIR = path.join(os.homedir(), '.claude', 'monitor', 'themes');

const BUILT_IN = {
  dark: {
    running: '#7aa2f7', thinking: '#bb9af7', done: '#9ece6a',
    asking: '#e0af68', interrupted: '#e0af68', idle: '#565f89',
    header: '#c0caf5', dim: '#565f89', accent: '#e0af68', border: '#3b4261',
  },
  light: {
    running: '#2f6fd0', thinking: '#7b4bc0', done: '#2e7d32',
    asking: '#b26a00', interrupted: '#b26a00', idle: '#8a8f98',
    header: '#1f2430', dim: '#8a8f98', accent: '#b26a00', border: '#cfd4dc',
  },
  solarized: {
    running: '#268bd2', thinking: '#6c71c4', done: '#859900',
    asking: '#b58900', interrupted: '#cb4b16', idle: '#586e75',
    header: '#93a1a1', dim: '#586e75', accent: '#b58900', border: '#073642',
  },
  // No colour at all: every role renders plain. Glyphs still differentiate.
  mono: {
    running: null, thinking: null, done: null,
    asking: null, interrupted: null, idle: null,
    header: null, dim: null, accent: null, border: null,
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
    // Fill any missing key from dark so a partial theme still renders.
    return { ...BUILT_IN.dark, ...raw };
  } catch (e) {
    return null;
  }
}

// Returns { name, colours, missing } — never throws, always renders something.
function resolve(name) {
  const wanted = String(name || 'dark');
  const theme = BUILT_IN[wanted] || loadUserTheme(wanted);
  if (!theme) {
    return { name: 'dark', colours: BUILT_IN.dark, fallbackFrom: wanted, missing: [] };
  }
  const missing = REQUIRED_KEYS.filter((k) => !(k in theme));
  return { name: wanted, colours: theme, missing };
}

function names() {
  return [...Object.keys(BUILT_IN), ...listUserThemes()];
}

module.exports = { resolve, names, hexToRgb, BUILT_IN, REQUIRED_KEYS, USER_THEME_DIR };
