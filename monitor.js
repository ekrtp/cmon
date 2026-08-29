#!/usr/bin/env node
// cmon — a read-only board for your Claude Code sessions.
// Fork of ibrahimokdadov/claudeMonitor, rebuilt; see README.md.
//
// A read-only wall display: one row per session, the title you gave it, a status
// derived from the transcript, and what each session is costing you. It watches;
// it never drives. No keyboard, no navigation, nothing written to Claude Code's
// own directories, and settings.json is never touched.
//
//   rows    <- ~/.claude/sessions/<PID>.json          (Claude Code's registry, read only)
//   title   <- dashboard.db sessions.name, else the transcript's ai-title
//   status  <- transcript: stop_reason / tool_use / interrupt markers
//   extras  <- model, effort, context, branch, queue depth (same read)
//              cost and sub-agents (dashboard.db), plan progress (~/.claude/tasks)
//   focus   <- which project the conversation is actually about (lib/projects.js)
//
// Usage:
//   node monitor.js                     live table
//   node monitor.js --once              render once and exit
//   node monitor.js --all               include empty tabs and stale sessions
//   node monitor.js --since=30m         only sessions active in the last 30m
//   node monitor.js --theme=nord        override the configured theme
//   node monitor.js --glyphs=emoji      emoji status glyphs
//   node monitor.js --columns=status,title,cost,time
//   node monitor.js --group=focus       status | focus | project | none
//   node monitor.js --compact           tighter rows
//   node monitor.js --no-animation      hold the status glyphs still
//   node monitor.js --wide              full session id
//   node monitor.js --themes            preview every theme and exit
//   node monitor.js --demo              fabricated sessions (screenshots, testing)
// Environment: NO_COLOR=1 disables colour.
//
// Config: ~/.claude/monitor/config.json — hot-reloaded, no restart needed.

const path = require('path');
const registry = require('./lib/registry');
const titles = require('./lib/titles');
const statusLib = require('./lib/status');
const state = require('./lib/state');
const themes = require('./lib/themes');
const configLib = require('./lib/config');
const ccboard = require('./lib/ccboard');
const tasksLib = require('./lib/tasks');
const projects = require('./lib/projects');
const notify = require('./lib/notify');
const identity = require('./lib/identity');
const demo = require('./lib/demo');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const ONCE = flag('once');
const ALL = flag('all');
// --demo renders fabricated sessions. The README screenshots come from here,
// never from a live machine.
const DEMO = flag('demo');

// --themes prints a coloured sample of every theme, so you can pick one by
// looking instead of by name.
if (flag('themes')) {
  const rgb = (hex) => {
    const c = themes.hexToRgb(hex);
    return c ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : '';
  };
  const sample = ['running', 'thinking', 'done', 'asking', 'interrupted', 'idle'];
  console.log('');
  for (const name of themes.names()) {
    const t = themes.resolve(name).colours;
    const swatch = sample.map((role) => `${rgb(t[role])}${role === 'interrupted' ? 'stopped' : role}\x1b[0m`).join(' ');
    const ctx = [0.2, 0.5, 0.8, 0.95].map((r) => {
      const c = themes.ramp(t, r);
      return c ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${Math.round(r * 100)}%\x1b[0m` : `${Math.round(r * 100)}%`;
    }).join(' ');
    console.log(`  ${rgb(t.accent)}${name.padEnd(18)}\x1b[0m ${swatch}   ${rgb(t.dim)}ctx\x1b[0m ${ctx}`);
  }
  console.log('');
  console.log('  Use one:   node monitor.js --theme=<name>        (just this run)');
  console.log('             node scripts/config.js set theme <name>   (permanent, applies live)');
  // Relative to home: an absolute path puts a username into anyone's screenshot.
  console.log('  Your own:  ' + themes.USER_THEME_DIR.replace(require('os').homedir(), '~') + '\\<name>.json');
  console.log('  Keys:      ' + themes.REQUIRED_KEYS.join(', '));
  process.exit(0);
}

// --- configuration ---------------------------------------------------------
const created = configLib.ensureFile();
let cfg = configLib.load();

function applyOverrides(base) {
  const c = { ...base };
  if (value('theme')) c.theme = value('theme');
  if (value('glyphs')) c.glyphs = value('glyphs') === 'emoji' ? 'emoji' : 'ascii';
  if (value('columns')) {
    const cols = value('columns').split(',').map((s) => s.trim()).filter(Boolean);
    if (cols.length) c.columns = cols.filter((x) => configLib.COLUMN_NAMES.includes(x));
  }
  if (value('group')) c.groupBy = value('group');
  if (value('since')) c.windowMs = configLib.parseWindow(value('since'));
  if (flag('compact')) c.density = 'compact';
  if (flag('no-animation')) c.animationMs = 0;
  if (flag('wide')) c.wide = true;
  if (flag('flat')) c.groupBy = 'none';
  if (ALL) { c.showEmpty = true; c.windowMs = 0; }
  return configLib.sanitise(c);
}

let active = applyOverrides(cfg);
let theme = themes.resolve(active.theme);

// Generated colours (the focus tags) must sit readably on whatever background
// the theme implies. `header` is the theme's brightest text colour, so a light
// theme is one whose header is DARK.
const themeIsLight = () => identity.luminance(themes.hexToRgb(theme.colours.header)) < 0.5;

const COLOUR_ON = !process.env.NO_COLOR && (process.stdout.isTTY || ONCE);
const RESET = COLOUR_ON ? '\x1b[0m' : '';
const BOLD = COLOUR_ON ? '\x1b[1m' : '';

function paint(role) {
  if (!COLOUR_ON) return '';
  const rgb = themes.hexToRgb(theme.colours[role]);
  if (!rgb) return '';
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// Static glyphs for settled states; the two live states get a spinner so the
// board reads as alive without anything moving that is not really moving.
const GLYPHS = {
  ascii: { asking: '!!', interrupted: '||', running: '>>', thinking: '..', done: 'OK', idle: '--' },
  emoji: { asking: '🔔', interrupted: '⏸️', running: '🔧', thinking: '💭', done: '✅', idle: '·' },
};
const SPINNERS = {
  ascii: ['|', '/', '-', '\\'],
  emoji: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};
let frame = 0;

function glyph(status) {
  const set = GLYPHS[active.glyphs] || GLYPHS.ascii;
  if (!active.animationMs) return set[status] || '·';
  if (status === 'running' || status === 'thinking') {
    const spin = SPINNERS[active.glyphs] || SPINNERS.ascii;
    return spin[frame % spin.length] + (status === 'running' ? '>' : '.');
  }
  // asking pulses slowly: it is the one state that should catch your eye.
  if (status === 'asking') return (frame % 8) < 4 ? set.asking : '· ';
  return set[status] || '·';
}

// --- theme picker ----------------------------------------------------------
// The only interactive thing in the tool. `t` opens a bar along the bottom;
// arrows move through the themes and recolour the whole board live; enter keeps
// the choice (written to the config), escape puts back what you had.
const picker = { open: false, index: 0, previous: null, saved: '' };

function openPicker() {
  const list = themes.names();
  picker.open = true;
  picker.previous = active.theme;
  picker.index = Math.max(0, list.indexOf(theme.name));
  picker.saved = '';
}

function previewTheme(name) {
  active = applyOverrides({ ...cfg, theme: name });
  theme = themes.resolve(name);
}

function movePicker(step) {
  const list = themes.names();
  picker.index = (picker.index + step + list.length) % list.length;
  previewTheme(list[picker.index]);
}

// `g` walks the grouping options and keeps the choice. One setting, one key —
// no menu, because the whole point of this board is that it does not need one.
function cycleGrouping() {
  const order = configLib.GROUP_BY;   // status -> focus -> project -> none
  const next = order[(order.indexOf(active.groupBy) + 1) % order.length];
  try {
    configLib.set('groupBy', next);   // sticky: the next run opens the same way
    cfg = configLib.load();
  } catch (e) { /* keep going with the in-memory value */ }
  // Preserve whatever theme is on screen — the picker may have changed it.
  active = applyOverrides({ ...cfg, groupBy: next, theme: active.theme });
}

function closePicker(keep) {
  const list = themes.names();
  if (keep) {
    const chosen = list[picker.index];
    try {
      configLib.set('theme', chosen);
      cfg = configLib.load();
      picker.saved = chosen;
    } catch (e) {
      picker.saved = '';
    }
  } else {
    previewTheme(picker.previous);
  }
  picker.open = false;
}

// One line, centred on the current theme, that fits the terminal.
function pickerBar(total) {
  const list = themes.names();
  const label = `${BOLD}${paint('accent')}theme${RESET} `;
  const room = total - 34;
  const around = 4;
  const start = Math.max(0, Math.min(picker.index - around, list.length - around * 2 - 1));
  const shown = list.slice(start, start + around * 2 + 1);

  let bar = '';
  for (const name of shown) {
    const t = themes.resolve(name).colours;
    const rgb = themes.hexToRgb(t.running);
    const colour = COLOUR_ON && rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '';
    const chip = name === list[picker.index] ? `${BOLD}${colour}[${name}]${RESET}` : `${colour}${name}${RESET}`;
    if (width(bar + ' ' + name) + 4 > room) break;
    bar += (bar ? ' ' : '') + chip;
  }

  const hint = `${paint('dim')}←→ pick · enter keep · esc cancel${RESET}`;
  return `  ${label}${start > 0 ? paint('dim') + '‹ ' + RESET : ''}${bar}` +
    `${start + shown.length < list.length ? paint('dim') + ' ›' + RESET : ''}  ${hint}`;
}

// --- text layout (lib/text.js: measurement, clipping, wrapping) ------------
const { width, clip, pad, wrap, ago, compactNumber, ANSI } = require('./lib/text');

const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// --- data ------------------------------------------------------------------
function collect() {
  if (DEMO) return demo.snapshot();
  const sessions = registry.liveSessions();
  const hookState = state.bySession();

  const rows = sessions.map((s) => {
    const hook = hookState.get(s.sessionId);
    const t = titles.resolve(s.sessionId, s.cwd, {
      hookPrompt: hook && hook.firstPrompt,
      userTitle: ccboard.name(s.sessionId),
    });
    const st = statusLib.derive(t.jsonl, { idleAfterMs: active.idleAfterMs });
    const money = ccboard.usage(s.sessionId);
    const agents = ccboard.agents(s.sessionId);
    const plan = tasksLib.progress(s.sessionId);
    const focus = projects.focusOf(s.sessionId, s.cwd, t.jsonl);
    const lastEvent = Math.max(st.lastEventMs || 0, t.mtimeMs || 0, (hook && hook.when) || 0);

    return {
      sessionId: s.sessionId,
      project: s.cwd ? path.basename(s.cwd) : 'unknown',
      cwd: s.cwd,
      title: t.title,
      titleSource: t.source,
      status: st.status,
      statusSource: st.source,
      action: st.action || (hook && hook.lastAction) || '',
      model: shortModel(st.model),
      branch: st.branch,
      effort: st.effort,
      permissionMode: st.permissionMode,
      contextTokens: st.contextTokens,
      queued: st.queued,
      cost: money ? money.cost : null,
      tokens: money ? money.tokens : null,
      agents,
      plan,
      focus,
      src: s.entrypoint === 'cli' ? 'cli' : (s.entrypoint === 'claude-vscode' ? 'vsc' : (s.entrypoint || '?').slice(0, 3)),
      lastEvent,
      empty: !t.jsonl,
      pid: s.pid,
    };
  }).sort((a, b) => {
    const d = statusLib.ATTENTION[a.status] - statusLib.ATTENTION[b.status];
    return d !== 0 ? d : b.lastEvent - a.lastEvent;
  });

  // Two different sessions can legitimately share a title — measured: a1b2c3d4
  // and b2c3d4e5 start from the same prompt and neither has an ai-title. Tag
  // those with their short id instead of showing what looks like a duplicate.
  const seen = new Map();
  for (const r of rows) seen.set(r.title, (seen.get(r.title) || 0) + 1);
  for (const r of rows) {
    if (seen.get(r.title) > 1) r.title = `${r.title} · ${r.sessionId.slice(0, 8)}`;
  }

  const empty = rows.filter((r) => r.empty);
  let visible = active.showEmpty ? rows : rows.filter((r) => !r.empty);
  let stale = 0;
  if (active.windowMs > 0) {
    const before = visible.length;
    visible = visible.filter((r) => Date.now() - r.lastEvent < active.windowMs);
    stale = before - visible.length;
  }
  return { rows: visible, hiddenEmpty: active.showEmpty ? 0 : empty.length, hiddenStale: stale };
}

// --- rendering -------------------------------------------------------------
const FIXED = {
  status: 13, project: 16, focus: 16, action: 13, model: 10, branch: 14, src: 5,
  session: 9, time: 5, ctx: 10, cost: 8, tokens: 8, tasks: 7, agents: 7, effort: 7, mode: 11,
};
const HEADS = {
  status: 'STATUS', title: 'TITLE', project: 'PROJECT', focus: 'FOCUS', action: 'ACTION',
  model: 'MODEL', branch: 'BRANCH', src: 'FROM', session: 'SESSION', time: 'AGE',
  ctx: 'CTX', cost: 'COST', tokens: 'TOKENS', tasks: 'TASKS', agents: 'AGENTS',
  effort: 'EFFORT', mode: 'MODE',
};

// The title carries the meaning, so it never shrinks below MIN_TITLE. On a
// narrow terminal, optional columns drop in this order instead.
const MIN_TITLE = 28;
// Ordered least useful first. The four that survive longest are the ones you
// actually act on: what it is running on (model, effort), how full the window
// is (ctx) and what it has cost.
const DROP_ORDER = ['mode', 'branch', 'agents', 'tokens', 'project', 'session',
  'src', 'action', 'tasks', 'focus', 'effort', 'model', 'cost', 'ctx'];

function layout(total, requested, indent, gap) {
  let columns = requested.slice();
  const widthOf = (c) => (c === 'session' ? (active.wide ? 37 : FIXED.session) : FIXED[c]);
  const spent = () => columns.filter((c) => c !== 'title')
    .reduce((sum, c) => sum + widthOf(c) + gap, indent);

  for (const candidate of DROP_ORDER) {
    if (total - spent() - 4 >= MIN_TITLE) break;
    if (!columns.includes(candidate)) continue;
    columns = columns.filter((c) => c !== candidate);
  }

  const w = {};
  for (const c of columns) if (c !== 'title') w[c] = widthOf(c);
  w.title = Math.max(16, total - spent() - 4);
  return { w, columns };
}

// ⚠️ Nothing records the size of a session's context window: it is not in the
// transcript's `usage` block, and the dashboard's `context_size` column reads
// "short" for every row, including a session that reached 872k (both measured).
// So the limit is an assumption, and the cell SHOWS it — "379k/1M" — instead of
// hiding it inside a percentage that would read 95% for a 1M session sitting at
// 190k.
const TIERS = [200000, 1000000];
function contextLimit(tokens) {
  const configured = Number(active.contextLimit) || TIERS[0];
  // Whatever a session has already used, its window is at least that big.
  return TIERS.find((t) => t >= Math.max(tokens, configured)) || tokens;
}

function formatLimit(limit) {
  return limit >= 1e6 ? `${Math.round(limit / 1e5) / 10}M`.replace('.0M', 'M') : `${Math.round(limit / 1e3)}k`;
}

function contextRatio(row) {
  if (!row.contextTokens) return 0;
  return row.contextTokens / contextLimit(row.contextTokens);
}

// The context cell is the one number you act on (compact this chat, or don't),
// so it gets its own colour: a continuous green -> amber -> red ramp built from
// the active theme rather than a fixed palette.
// Same project, same colour, every row and every run — derived from the name,
// never assigned in order of appearance.
function focusPaint(row) {
  if (!COLOUR_ON || !row.focus) return '';
  if (!themes.hexToRgb(theme.colours.running)) return '';   // mono: no colour at all
  const c = identity.colourFor(row.focus.name, { light: themeIsLight() });
  return `[38;2;${c[0]};${c[1]};${c[2]}m`;
}

// Zebra striping. A row can occupy two or three lines once the title wraps, and
// without a band it is genuinely hard to see where one session ends and the next
// begins. The stripe is drawn from the theme's own background, nudged towards
// its text colour by `zebraStrength` — subtle enough to read as texture, not as
// a highlight.
function stripeCode() {
  if (!COLOUR_ON || !active.zebra) return '';
  const bg = themes.hexToRgb(theme.colours.bg);
  const fg = themes.hexToRgb(theme.colours.header);
  if (!bg || !fg) return '';                    // mono, or a theme without a bg
  const c = themes.mix(theme.colours.bg, theme.colours.header, active.zebraStrength);
  return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}

// Every RESET inside the line would also clear the background, so the stripe is
// re-applied after each one, and the line is padded to the full width so the
// band runs to the edge.
function applyStripe(line, code, total) {
  if (!code) return line;
  const padded = line + ' '.repeat(Math.max(0, total - width(line)));
  return code + padded.split(RESET).join(RESET + code) + '\x1b[0m';
}

function contextPaint(row) {
  if (!COLOUR_ON) return '';
  const c = themes.ramp(theme.colours, contextRatio(row));
  return c ? `[38;2;${c[0]};${c[1]};${c[2]}m` : '';
}

function cell(row, col) {
  switch (col) {
    case 'status': return `${glyph(row.status)} ${row.status}`;
    case 'title': return row.title;
    case 'project': return row.project;
    case 'focus': {
      if (!row.focus) return '—';
      const mark = identity.glyphFor(row.focus.name, active.glyphs);
      return `${mark} ${row.focus.name}${row.focus.confident ? '' : ' ?'}`;
    }
    case 'action': return row.action || '—';
    case 'model': return row.model || '—';
    case 'branch': return row.branch || '—';
    case 'src': return `[${row.src}]`;
    case 'session': return active.wide ? row.sessionId : row.sessionId.slice(0, 8);
    case 'time': return ago(row.lastEvent);
    case 'ctx': {
      if (!row.contextTokens) return '—';
      return `${compactNumber(row.contextTokens)}/${formatLimit(contextLimit(row.contextTokens))}`;
    }
    case 'cost': return row.cost == null ? '—' : '$' + row.cost.toFixed(2);
    case 'tokens': return row.tokens == null ? '—' : compactNumber(row.tokens);
    case 'tasks': return row.plan ? `${row.plan.completed}/${row.plan.total}` : '—';
    case 'agents': return row.agents && row.agents.total ? `${row.agents.running}/${row.agents.total}` : '—';
    case 'effort': return row.effort || '—';
    case 'mode': return row.permissionMode || '—';
    default: return '';
  }
}

// Group heading order: the statuses that want you come first, matching the row
// sort, so the eye lands on what is waiting.
const STATUS_ORDER = ['asking', 'interrupted', 'running', 'thinking', 'done', 'idle'];
const STATUS_HEADING = {
  asking: 'waiting for you', interrupted: 'interrupted', running: 'running a tool',
  thinking: 'thinking', done: 'finished', idle: 'idle',
};

function groupsOf(rows) {
  const by = active.groupBy;
  if (by === 'none') return null;

  const map = new Map();
  for (const r of rows) {
    const key = by === 'status' ? r.status
      : by === 'focus' ? (r.focus ? r.focus.name : 'unknown')
        : r.project;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }

  const keys = [...map.keys()];
  if (by === 'status') keys.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
  else keys.sort((a, b) => map.get(b).length - map.get(a).length);

  return keys.map((key) => ({ key, rows: map.get(key) }));
}

function render(snapshot) {
  const { rows, hiddenEmpty, hiddenStale } = snapshot;
  const roomy = active.density !== 'compact';
  const gap = roomy ? 2 : 1;
  const sep = ' '.repeat(gap);

  // COLUMNS env lets a piped run (tests, CI) exercise a real terminal width.
  const detected = process.stdout.columns || Number(process.env.COLUMNS) || 100;
  const total = Math.max(60, Math.min(detected, 220));
  const grouped = groupsOf(rows);
  const indent = grouped ? 2 : 0;
  const { w, columns: cols } = layout(total, active.columns, indent, gap);
  const rule = paint('border') + '─'.repeat(total - 4) + RESET;

  const out = [];
  // A frozen clock in demo mode keeps regenerated screenshots byte-identical.
  const clock = DEMO ? '09:41:07' : new Date().toLocaleTimeString();
  out.push(`  ${BOLD}${paint('accent')}cmon${RESET}${paint('dim')} claude monitor${RESET}  ${paint('dim')}${clock} · ` +
    `${rows.length} session${rows.length === 1 ? '' : 's'} · theme ${theme.name}` +
    `${theme.fallbackFrom ? ` (unknown "${theme.fallbackFrom}", using dark)` : ''}` +
    `${active.notifications ? ' · notify on' : ''}${RESET}`);
  out.push('  ' + rule);
  if (roomy) out.push('');

  if (!rows.length) {
    const hidden = [];
    if (hiddenEmpty) hidden.push(`${hiddenEmpty} empty`);
    if (hiddenStale) hidden.push(`${hiddenStale} stale`);
    out.push(`  ${paint('dim')}Nothing to show${hidden.length ? ` (${hidden.join(', ')} hidden — try --all)` : ''}.${RESET}`);
    return out.join('\n');
  }

  const header = (lead) => `  ${BOLD}${paint('header')}${lead}` +
    cols.map((c) => pad(HEADS[c], w[c])).join(sep) + RESET;

  // A row can occupy more than one line: a long title wraps into the TITLE
  // column instead of being cut off, up to titleLines. Every other column stays
  // on the first line, so the table still scans vertically.
  // Columns whose value is a name rather than a measurement: too long to cut,
  // so they wrap down instead. Everything else stays on the first line.
  const WRAPPABLE = ['title', 'focus'];

  const lines = (row, lead, striped) => {
    const stripe = striped ? stripeCode() : '';
    const colour = paint(row.status) || paint('idle');
    const needsYou = row.status === 'asking' || row.status === 'interrupted';

    const chunks = {};
    let height = 1;
    for (const c of cols) {
      if (!WRAPPABLE.includes(c)) continue;
      chunks[c] = wrap(cell(row, c), w[c], active.titleLines);
      height = Math.max(height, chunks[c].length);
    }

    const cellText = (c, i) => (chunks[c] ? (chunks[c][i] || '') : (i === 0 ? cell(row, c) : ''));
    const renderLine = (i) => cols.map((c) => {
      const text = pad(cellText(c, i), w[c]);
      if (i > 0 && !chunks[c]) return text;                          // continuation: blank
      if (c === 'status') return colour + (needsYou ? BOLD : '') + text + RESET;
      if (c === 'title') return (needsYou ? BOLD + colour : '') + text + RESET;
      if (c === 'ctx') return contextPaint(row) + text + RESET;
      if (c === 'focus') return focusPaint(row) + text + RESET;
      return paint('dim') + text + RESET;
    }).join(sep);

    const extras = [];
    if (row.queued) extras.push(`${colour}+${row.queued} queued${RESET}`);
    if (row.plan && row.plan.current) extras.push(`${paint('dim')}▸ ${clip(row.plan.current, 30)}${RESET}`);

    const out = ['  ' + lead + renderLine(0) + (extras.length ? sep + extras.join(' ') : '')];
    for (let i = 1; i < height; i++) out.push('  ' + lead + renderLine(i));
    // The band covers EVERY line of the row, which is what makes a wrapped title
    // read as one session instead of two.
    return out.map((l) => applyStripe(l, stripe, total));
  };

  // The stripe alternates across the WHOLE table, not within each group: with
  // one row per group nothing would ever alternate.
  let rowIndex = 0;
  const emit = (r, lead) => out.push(...lines(r, lead, rowIndex++ % 2 === 1));

  if (!grouped) {
    out.push(header(''));
    out.push('  ' + rule);
    for (const r of rows) emit(r, '');
  } else {
    out.push(header('  '));
    out.push('  ' + rule);
    for (const group of grouped) {
      const label = active.groupBy === 'status'
        ? (STATUS_HEADING[group.key] || group.key)
        : group.key;
      const colour = active.groupBy === 'status' ? (paint(group.key) || paint('header')) : paint('header');
      out.push(`  ${BOLD}${colour}${label}${RESET}${paint('dim')} · ${group.rows.length}${RESET}`);
      for (const r of group.rows) emit(r, '  ');
      if (roomy) out.push('');
    }
    if (roomy) out.pop();   // no trailing blank before the footer rule
  }

  if (roomy) out.push('');
  out.push('  ' + rule);
  const sources = {};
  for (const r of rows) sources[r.titleSource] = (sources[r.titleSource] || 0) + 1;
  const hidden = [];
  if (hiddenEmpty) hidden.push(`${hiddenEmpty} empty`);
  if (hiddenStale) hidden.push(`${hiddenStale} stale`);
  const dropped = active.columns.filter((c) => !cols.includes(c));
  out.push(`  ${paint('dim')}titles ${Object.entries(sources).map(([k, v]) => `${k}:${v}`).join(' · ')}` +
    `${hidden.length ? ` · hidden ${hidden.join(', ')}` : ''}` +
    `${dropped.length ? ` · narrow, dropped ${dropped.join(', ')}` : ''}${RESET}`);
  if (!ONCE) {
    if (picker.open) {
      out.push(pickerBar(total));
    } else {
      out.push(`  ${paint('dim')}watching · ${active.refreshMs / 1000}s refresh · grouped by ${active.groupBy}` +
        ` · t theme · Ctrl+C to exit` +
        `${picker.saved ? ` · saved theme ${picker.saved}` : ''}${RESET}`);
    }
  }
  return out.join('\n');
}

// Flicker-free: home the cursor and clear to end of line rather than wiping the
// screen every frame.
let previousLines = 0;
function paintFrame(snapshot) {
  const text = render(snapshot);
  if (ONCE) {
    process.stdout.write(text + '\n');
    return;
  }
  const lines = text.split('\n');
  process.stdout.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[K');
  if (lines.length < previousLines) process.stdout.write('\n\x1b[J');
  previousLines = lines.length;
}

// --- main ------------------------------------------------------------------
if (ONCE) {
  paintFrame(collect());
  ccboard.close();
} else {
  // Two clocks: data is re-read on refreshMs, the spinner advances on
  // animationMs. Animating never touches the disk — it repaints the snapshot.
  let snapshot = collect();
  notify.check(snapshot.rows, active.notifications);

  process.stdout.write('\x1b[2J\x1b[?25l');
  paintFrame(snapshot);

  const refresh = () => {
    snapshot = collect();
    notify.forget(new Set(snapshot.rows.map((r) => r.sessionId)));
    notify.check(snapshot.rows, active.notifications);
    paintFrame(snapshot);
  };

  let dataTimer = setInterval(refresh, active.refreshMs);
  let animTimer = active.animationMs
    ? setInterval(() => { frame++; paintFrame(snapshot); }, active.animationMs)
    : null;

  const retime = () => {
    clearInterval(dataTimer);
    if (animTimer) clearInterval(animTimer);
    dataTimer = setInterval(refresh, active.refreshMs);
    animTimer = active.animationMs
      ? setInterval(() => { frame++; paintFrame(snapshot); }, active.animationMs)
      : null;
  };

  const unwatch = configLib.watch((next) => {
    cfg = next;
    const before = { refreshMs: active.refreshMs, animationMs: active.animationMs };
    active = applyOverrides(cfg);
    theme = themes.resolve(active.theme);
    if (before.refreshMs !== active.refreshMs || before.animationMs !== active.animationMs) retime();
    process.stdout.write('\x1b[2J');
    previousLines = 0;
    paintFrame(snapshot);
  });

  process.stdout.on('resize', () => {
    process.stdout.write('\x1b[2J');
    previousLines = 0;
    paintFrame(snapshot);
  });

  // The board listens for exactly one key: `t`, which opens the theme picker.
  // There is no row navigation — this is a display, not a console.
  const keyboard = process.stdin.isTTY && !flag('no-input');

  const quit = () => {
    clearInterval(dataTimer);
    if (animTimer) clearInterval(animTimer);
    unwatch();
    ccboard.close();
    if (keyboard) {
      try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
      process.stdin.pause();
    }
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  };

  process.on('SIGINT', quit);

  if (keyboard) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === '\u0003') return quit();

      if (!picker.open) {
        if (key === 't') { openPicker(); paintFrame(snapshot); }
        else if (key === 'g') { cycleGrouping(); paintFrame(snapshot); }
        else if (key === 'q') quit();
        return;
      }

      switch (key) {
        case '\u001b[C': case '\u001b[B': case 'l': case 'j': movePicker(1); break;
        case '\u001b[D': case '\u001b[A': case 'h': case 'k': movePicker(-1); break;
        case '\r': case '\n': closePicker(true); break;
        case '\u001b': case 'q': case 't': closePicker(false); break;
        default: return;
      }
      paintFrame(snapshot);
    });
  }
}
