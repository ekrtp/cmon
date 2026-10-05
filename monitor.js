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
//              plan progress (~/.claude/tasks)
//   cost    <- usage on every transcript line, sub-agents included (lib/cost.js)
//   tree    <- sub-agents and workflow runs, from <session>/subagents/ (lib/subagents.js)
//   focus   <- which project the conversation is actually about (lib/projects.js)
//
// Usage:  cmon [options]        (or `node monitor.js` if the command is not installed)
//   --once                 render once and exit
//   --all                  include empty tabs and stale sessions
//   --since=30m            only sessions active in the last 30 minutes
//   --theme=nord           override the configured theme
//   --themes               preview every theme and exit
//   --group=focus          status | focus | project | none
//   --columns=status,title,cost,time
//   --glyphs=emoji         emoji status glyphs
//   --compact              tighter rows
//   --no-animation         hold the status glyphs still
//   --wide                 full session id
//   --no-agents            hide the sub-agent and workflow tree under each session
//   --no-input             ignore the keyboard
//   --web                  serve the board as a local page (127.0.0.1) instead
//   --port=4280            port for --web
//   --demo                 fabricated sessions (screenshots, testing)
//   --version  --help
// Keys: t theme picker · g grouping · a agent tree on/off · Ctrl+C exit
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
const subagents = require('./lib/subagents');
const costLib = require('./lib/cost');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (flag('version') || flag('v')) {
  const pkg = require('./package.json');
  console.log(`${pkg.name} ${pkg.version}`);
  console.log(pkg.description);
  console.log('https://github.com/ekrtp/cmon');
  process.exit(0);
}

if (flag('help') || flag('h')) {
  // The header comment of this file is the help text; print the usage block.
  const src = require('fs').readFileSync(__filename, 'utf8');
  const usage = src.slice(src.indexOf('// Usage:'), src.indexOf('// Config:'));
  console.log('\n' + usage.replace(/^\/\/ ?/gm, '  ').trimEnd() + '\n');
  process.exit(0);
}

const ONCE = flag('once');
const ALL = flag('all');
// --demo renders fabricated sessions. The README screenshots come from here,
// never from a live machine.
const DEMO = flag('demo');
// --no-agents holds for this run until `a` is pressed, which then decides.
let noAgentsFlag = flag('no-agents');

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
  if (noAgentsFlag) c.showAgents = false;
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

// `a` shows or hides the sub-agent tree, and keeps the choice like `g` does.
function toggleAgents() {
  const next = !active.showAgents;
  noAgentsFlag = false;
  try {
    configLib.set('showAgents', next);
    cfg = configLib.load();
  } catch (e) { /* keep going with the in-memory value */ }
  active = applyOverrides({ ...cfg, showAgents: next, theme: active.theme });
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
const { width, clip, clipAnsi, pad, wrap, ago, compactNumber, ANSI } = require('./lib/text');

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
      boardTitle: ccboard.name(s.sessionId),
    });
    const st = statusLib.derive(t.jsonl, { idleAfterMs: active.idleAfterMs });
    const money = costLib.forSession(s.sessionId, t.jsonl);
    const agents = ccboard.agents(s.sessionId);
    const plan = tasksLib.progress(s.sessionId);
    const focus = projects.focusOf(s.sessionId, s.cwd, t.jsonl);
    const lastEvent = Math.max(st.lastEventMs || 0, t.mtimeMs || 0, (hook && hook.when) || 0);
    const tree = subagents.forSession(s.sessionId, t.jsonl, {
      idleAfterMs: active.idleAfterMs, agentIdleAfterMs: active.agentIdleAfterMs,
      lingerMs: active.agentLingerMs, maxLines: active.agentLines,
    });

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
      tree,
      plan,
      focus,
      src: s.entrypoint === 'cli' ? 'cli' : (s.entrypoint === 'claude-vscode' ? 'vsc' : (s.entrypoint || '?').slice(0, 3)),
      lastEvent,
      empty: !t.jsonl,
      pid: s.pid,
      jsonl: t.jsonl,
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
    case 'action': return backgroundWork(row) || row.action || '—';
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
    case 'agents': {
      // The files on disk are live; dashboard.db only as fresh as its writer.
      const a = row.tree && row.tree.counts.total ? row.tree.counts : row.agents;
      return a && a.total ? `${a.running}/${a.total}` : '—';
    }
    case 'effort': return row.effort || '—';
    case 'mode': return row.permissionMode || '—';
    default: return '';
  }
}

// The tree under a session. Box-drawing is chrome, like the '─' rules the board
// already draws in both glyph sets, so it does not change with `glyphs`; the
// workflow mark is a glyph and does. '⚙' is left out on purpose: it has no
// fixed cell width (one cell as text, two as emoji), which shifts every column
// after it.
const TREE = { mid: '├─ ', last: '└─ ', pipe: '│  ', blank: '   ' };
const WF_MARK = () => (active.glyphs === 'emoji' ? '🧩' : 'wf');
// Columns a child line fills in; the title span runs up to the next of these.
const CHILD_COLUMNS = ['status', 'time'];
// Agent types too common to be worth a word on every line.
const GENERIC_AGENT = ['general-purpose', 'workflow-subagent', ''];

// A session that launched a workflow ends its own turn and reads "done" while
// the workflow is still working — including between two of its agents, when
// no agent is open at all. The ACTION cell says so, or the row looks finished.
// ACTION is among the first columns a narrow terminal drops, so without it the
// STATUS cell (never dropped) carries a short form: "done +wf", "done +2ag".
function backgroundWork(row) {
  const tc = row.tree && row.tree.counts;
  const what = row.status === 'done' || row.status === 'idle' ? subagents.busy(tc) : '';
  if (!what) return '';
  return what === 'workflow' ? `${WF_MARK()} running` : `${tc.running} agent${tc.running === 1 ? '' : 's'}`;
}

// "+N more" in nodes, with their kind: a cut workflow is not "4 more agents".
function moreText(tree) {
  const h = tree.hidden;
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  if (!h || !(h.workflows || h.agents)) return `+${tree.overflow} more`;
  if (!h.workflows) return `+${h.agents} more ${h.agents === 1 ? 'agent' : 'agents'}`;
  return `+${n(h.workflows, 'more workflow')}${h.agents ? ', ' + n(h.agents, 'agent') : ''}`;
}

function backgroundMark(row) {
  const tc = row.tree && row.tree.counts;
  if (!backgroundWork(row)) return '';
  return tc.workflows ? `+${WF_MARK()}` : `+${tc.running}ag`;
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

  // --- the sub-agent tree, under the TITLE column --------------------------
  // A child line reuses the parent's columns: STATUS carries the child's own
  // glyph and status, AGE its age, and the title span its connector and label.
  // That span runs on through any columns a child leaves blank, so a label is
  // only cut when the whole line runs out.
  const titleAt = cols.indexOf('title');
  let spanEnd = titleAt + 1;
  while (spanEnd < cols.length && !CHILD_COLUMNS.includes(cols[spanEnd])) spanEnd++;
  const titleSpan = cols.slice(titleAt, spanEnd).reduce((sum, c, i) => sum + w[c] + (i ? gap : 0), 0);

  // [text, colour, keep] pieces laid into exactly `max` cells, clipped in
  // plain text so an escape is never cut in half. A cut always shows as '…',
  // also when a whole later piece is what fell off. A `keep` piece (a
  // workflow's done/total) has its room reserved at the end, so a long name
  // gives way to it instead of the other way round.
  const ellipsize = (t, n) => {
    let out = '';
    for (const ch of t) { if (width(out + ch) > n - 1) break; out += ch; }
    return out + '…';
  };
  const fit = (parts, max) => {
    const put = (text, code) => (code || '') + text + (code ? RESET : '');
    const kept = parts.filter((p) => p[0] && p[2]);
    const keepW = kept.reduce((n, p) => n + width(p[0]), 0);
    const reserve = keepW && keepW <= max / 2 ? keepW : 0;
    const flow = reserve ? parts.filter((p) => !p[2]) : parts;
    const room = max - reserve;
    const live = flow.filter((p) => p[0]);
    let used = 0;
    let s = '';
    for (let i = 0; i < live.length; i++) {
      const [text, code] = live[i];
      const avail = room - used;
      if (avail <= 0) break;
      const later = i < live.length - 1;
      if (width(text) < avail || (width(text) === avail && !later)) {
        s += put(text, code);
        used += width(text);
        continue;
      }
      const t = ellipsize(text, avail);
      s += put(t, code);
      used += width(t);
      break;
    }
    if (reserve) { for (const [text, code] of kept) s += put(text, code); used += reserve; }
    return s + ' '.repeat(Math.max(0, max - used));
  };

  const agentEntry = (a, prefix) => {
    const detail = [a.action, a.model, GENERIC_AGENT.includes(a.type) ? '' : a.type].filter(Boolean).join(' · ');
    return { prefix, status: a.status, statusText: a.status, label: a.label, detail, age: a.lastEventMs };
  };

  const treeLines = (row) => {
    let tree = row.tree;
    if (!active.showAgents || !tree || !tree.items || !tree.items.length) return [];
    // A short terminal: fitToScreen() handed this row a smaller budget.
    const cap = treeCaps ? treeCaps.get(row.sessionId) : undefined;
    if (cap === 0) return [];
    if (cap !== undefined && cap < subagents.lineCount(tree)) tree = subagents.fit(tree, cap);
    const T = TREE;
    const top = tree.items.length + (tree.overflow ? 1 : 0);
    const entries = [];
    tree.items.forEach((it, i) => {
      const lastTop = i === top - 1;
      const lead = lastTop ? T.last : T.mid;
      if (it.kind !== 'workflow') { entries.push(agentEntry(it.node, lead)); return; }
      const wf = it.node;
      entries.push({
        prefix: lead,
        status: wf.state,
        statusText: wf.state === 'interrupted' ? wf.status : wf.state,
        label: `${WF_MARK()} ${wf.name}`,
        detail: wf.phase,
        counter: `${wf.done}/${wf.total}`,
        age: wf.lastEventMs,
      });
      wf.agents.forEach((a, k) => entries.push(agentEntry(a,
        (lastTop ? T.blank : T.pipe) + (k === wf.agents.length - 1 ? T.last : T.mid))));
    });
    if (tree.overflow) entries.push({ prefix: T.last, more: moreText(tree) });

    return entries.map((e) => {
      const needsYou = e.status === 'asking' || e.status === 'interrupted';
      const parts = e.more
        ? [[e.prefix, paint('border')], [e.more, paint('dim')]]
        : [[e.prefix, paint('border')],
          [e.label, needsYou ? BOLD + (paint(e.status) || '') : ''],
          [e.detail ? ' · ' + e.detail : '', paint('dim')],
          [e.counter ? ' · ' + e.counter : '', paint('dim'), true]];
      const segs = [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (i === titleAt) { segs.push(fit(parts, titleSpan)); i = spanEnd - 1; continue; }
        if (c === 'status' && !e.more) {
          const colour = paint(e.status) || paint('idle');
          segs.push(colour + (needsYou ? BOLD : '') + pad(`${glyph(e.status)} ${e.statusText}`, w.status) + RESET);
        } else if (c === 'time' && !e.more) {
          segs.push(paint('dim') + pad(ago(e.age), w.time) + RESET);
        } else {
          segs.push(' '.repeat(w[c]));
        }
      }
      return segs.join(sep);
    });
  };

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

    const mark = cols.includes('action') ? '' : backgroundMark(row);
    const opening = (c) => (c === 'status' && mark ? `${cell(row, c)} ${mark}` : cell(row, c));
    const cellText = (c, i) => (chunks[c] ? (chunks[c][i] || '') : (i === 0 ? opening(c) : ''));
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

    // Extras go after the last column, one at a time, as long as each fits
    // whole: half a "+1 queued" says nothing.
    let first = '  ' + lead + renderLine(0);
    let joiner = sep;
    for (const x of extras) {
      if (width(first + joiner + x) > total) break;
      first += joiner + x;
      joiner = ' ';
    }
    const out = [first];
    for (let i = 1; i < height; i++) out.push('  ' + lead + renderLine(i));
    for (const l of treeLines(row)) out.push('  ' + lead + l);
    // The band covers EVERY line of the row — wrapped title and tree included —
    // which is what makes the block read as one session instead of several.
    // Nothing may run past the edge: an overlong line wraps and shears the table.
    return out.map((l) => applyStripe(clipAnsi(l, total), stripe, total));
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
        ` · t theme · g group · a agents ${active.showAgents ? 'on' : 'off'} · Ctrl+C to exit` +
        `${picker.saved ? ` · saved theme ${picker.saved}` : ''}${RESET}`);
    }
  }
  // Header and footer too: a line wider than the terminal wraps and shears the
  // table. (The footer names the dropped columns, which gets long when narrow.)
  return out.map((l) => clipAnsi(l, total)).join('\n');
}

// The frame is repainted in place, so it must fit the terminal's height: one
// line more and every repaint scrolls, the header leaves the screen and the
// scrollback fills. The tree is what gives way — sessions are never cut. Its
// budget is whatever the frame without trees leaves over, handed out one line
// at a time across the sessions that have a tree, so each keeps at least its
// "+N more" line before any gets a second one.
// Height comes from the terminal; LINES stands in when piped (tests).
let treeCaps = null;   // sessionId -> tree lines allowed; null = no limit
function screenRows() {
  if (process.stdout.isTTY && process.stdout.rows) return process.stdout.rows;
  return Number(process.env.LINES) || 0;
}

function fitToScreen(snapshot) {
  const full = render(snapshot);
  const rows = screenRows();
  const height = (text) => text.split('\n').length;
  if (!rows || !active.showAgents || height(full) <= rows) return full;
  const withTrees = snapshot.rows.filter((r) => subagents.lineCount(r.tree) > 0);
  if (!withTrees.length) return full;
  try {
    treeCaps = new Map(withTrees.map((r) => [r.sessionId, 0]));
    let budget = rows - height(render(snapshot));
    let moved = true;
    while (budget > 0 && moved) {
      moved = false;
      for (const r of withTrees) {
        if (budget <= 0) break;
        const cap = treeCaps.get(r.sessionId);
        if (cap < subagents.lineCount(r.tree)) { treeCaps.set(r.sessionId, cap + 1); budget--; moved = true; }
      }
    }
    return render(snapshot);
  } finally {
    treeCaps = null;
  }
}

// Flicker-free: home the cursor and clear to end of line rather than wiping the
// screen every frame.
let previousLines = 0;
function paintFrame(snapshot) {
  const text = fitToScreen(snapshot);
  if (ONCE) {
    process.stdout.write(text + '\n');
    return;
  }
  const lines = text.split('\n');
  process.stdout.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[K');
  if (lines.length < previousLines) process.stdout.write('\n\x1b[J');
  previousLines = lines.length;
}

// --- web -------------------------------------------------------------------
// `--web` serves the board as a local page instead of painting the terminal.
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

function webState(snapshot, events) {
  const light = themeIsLight();
  const rows = snapshot.rows.map((r) => {
    const { jsonl, tree, ...rest } = r;
    const nodes = (tree && (tree.all || tree.items)) || [];
    return {
      ...rest,
      focusColour: r.focus ? hex(identity.colourFor(r.focus.name, { light })) : null,
      contextLimit: r.contextTokens ? contextLimit(r.contextTokens) : null,
      workflows: nodes.filter((it) => it.kind === 'workflow').map((it) => ({
        ...it.node, cost: DEMO ? (it.node.cost || 0) : costLib.forRun(jsonl, r.sessionId, it.node.runId),
      })),
      agents: nodes.filter((it) => it.kind === 'agent').map((it) => it.node),
      agentCounts: tree ? tree.counts : null,
    };
  });
  return {
    theme: { name: active.theme, colours: theme.colours, light },
    rows,
    hiddenEmpty: snapshot.hiddenEmpty,
    hiddenStale: snapshot.hiddenStale,
    timeline: events,
    demo: DEMO,
  };
}

if (flag('web')) {
  const web = require('./lib/web');
  const timeline = require('./lib/timeline');
  const port = Number(value('port')) || 4280;
  const runCost = (row, runId) => costLib.forRun(row.jsonl, row.sessionId, runId);
  const tick = () => {
    const snapshot = collect();
    notify.forget(new Set(snapshot.rows.map((r) => r.sessionId)));
    notify.check(snapshot.rows, active.notifications);
    const events = DEMO ? demo.timeline() : timeline.observe(snapshot.rows, { runCost });
    server.publish(webState(snapshot, events));
  };
  const server = web.start(port, (url) => {
    console.log(`cmon --web  ${url}`);
    console.log('Open it in VS Code: Ctrl+Shift+P > "Simple Browser: Show" and paste the address. Ctrl+C stops.');
  });
  tick();
  let timer = setInterval(tick, active.refreshMs);
  configLib.watch((next) => {
    cfg = next;
    active = applyOverrides(cfg);
    theme = themes.resolve(active.theme);
    clearInterval(timer);
    timer = setInterval(tick, active.refreshMs);
    tick();
  });
  process.on('SIGINT', () => { server.close(); ccboard.close(); process.exit(0); });
}

// --- main ------------------------------------------------------------------
if (flag('web')) {
  // the web branch above owns the process
} else if (ONCE) {
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

  // The board listens for three keys: `t` opens the theme picker, `g` cycles the
  // grouping, `a` shows or hides the agent tree. There is no row navigation —
  // this is a display, not a console.
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
        else if (key === 'a') { toggleAgents(); paintFrame(snapshot); }
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
