// Config file: ~/.claude/monitor/config.json — created with defaults on first
// run. Watched with fs.watchFile, so editing it re-styles a running monitor
// without a restart (theme, glyphs, columns, refresh rate, filters).

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude', 'monitor');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  theme: 'dark',                 // dark | light | solarized | mono | <your own>
  glyphs: 'ascii',               // ascii | emoji
  columns: ['status', 'title', 'action', 'model', 'branch', 'src', 'session', 'time'],
  refreshMs: 2000,
  window: '4h',                  // only sessions active within this window (0 = all)
  showEmpty: false,              // chat tabs that never received a message
  group: true,                   // group rows under their project
  wide: false,                   // full session id instead of first 8 chars
  idleAfterMs: 120000,           // running/thinking older than this reads as idle
  notifications: false,          // reserved: desktop notification on "asking"
};

const COLUMN_NAMES = ['status', 'title', 'project', 'action', 'model', 'branch', 'src', 'session', 'time'];

function parseWindow(value) {
  if (value === 0 || value === '0' || value === null) return 0;   // no filter
  const m = /^(\d+)\s*([mhd])$/.exec(String(value || '').trim());
  if (!m) return 4 * 3600 * 1000;
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60000 : m[2] === 'h' ? 3600000 : 86400000);
}

// Unknown keys are kept (forward compatible), bad values fall back to defaults.
function sanitise(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (c.glyphs !== 'emoji') c.glyphs = 'ascii';
  if (!Array.isArray(c.columns) || !c.columns.length) c.columns = [...DEFAULTS.columns];
  c.columns = c.columns.filter((x) => COLUMN_NAMES.includes(x));
  if (!c.columns.includes('title')) c.columns.unshift('title');
  c.refreshMs = Number(c.refreshMs) >= 250 ? Number(c.refreshMs) : DEFAULTS.refreshMs;
  c.idleAfterMs = Number(c.idleAfterMs) >= 5000 ? Number(c.idleAfterMs) : DEFAULTS.idleAfterMs;
  c.windowMs = parseWindow(c.window);
  return c;
}

function load() {
  try {
    return sanitise(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    return sanitise(null);
  }
}

// Write defaults once, atomically, if there is no config yet. Never overwrites
// an existing file.
function ensureFile() {
  try {
    if (fs.existsSync(FILE)) return { created: false, path: FILE };
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
    return { created: true, path: FILE };
  } catch (e) {
    return { created: false, path: FILE, error: e.message };
  }
}

// Hot reload. Editors often write via rename, so watch the directory too.
function watch(onChange) {
  const fire = () => {
    try { onChange(load()); } catch (e) { /* keep the previous config */ }
  };
  try {
    fs.watchFile(FILE, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) fire();
    });
  } catch (e) { /* watching is optional */ }
  return () => { try { fs.unwatchFile(FILE); } catch (e) { /* ignore */ } };
}

module.exports = { load, ensureFile, watch, DEFAULTS, COLUMN_NAMES, FILE, DIR, parseWindow, sanitise };
