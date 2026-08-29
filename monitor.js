#!/usr/bin/env node
// Claude Code session monitor — fork (ekrtp), upstream: ibrahimokdadov/claudeMonitor
//
// One row per session, the title you actually gave it, and a status derived from
// the transcript instead of from hook side effects.
//
//   rows    <- ~/.claude/sessions/<PID>.json          (Claude Code's registry, read only)
//   title   <- dashboard.db sessions.name, else the transcript's ai-title
//   status  <- transcript: stop_reason / tool_use / interrupt markers
//   extras  <- model, branch, effort, context size, queue depth (same read)
//              cost and sub-agents (dashboard.db), task progress (~/.claude/tasks)
//
// No hooks required: settings.json is never touched.
//
// Usage:
//   node monitor.js                     live table (interactive when on a TTY)
//   node monitor.js --once              render once and exit
//   node monitor.js --all               include empty tabs and stale sessions
//   node monitor.js --since=30m         only sessions active in the last 30m
//   node monitor.js --theme=light       override the configured theme
//   node monitor.js --glyphs=emoji      emoji status glyphs
//   node monitor.js --columns=status,title,cost,time
//   node monitor.js --wide              full session id
//   node monitor.js --flat              no project grouping
//   node monitor.js --no-input          disable the keyboard, plain output
//   node monitor.js --themes            list themes and exit
// Environment: NO_COLOR=1 disables colour.
//
// Keys (interactive): up/down or j/k select · enter open in VS Code
//   e explorer · c copy id · a all · g group · t theme · n notifications · q quit
//
// Config: ~/.claude/monitor/config.json — hot-reloaded, no restart needed.

const path = require('path');
const { spawn } = require('child_process');
const registry = require('./lib/registry');
const titles = require('./lib/titles');
const statusLib = require('./lib/status');
const state = require('./lib/state');
const themes = require('./lib/themes');
const configLib = require('./lib/config');
const ccboard = require('./lib/ccboard');
const tasksLib = require('./lib/tasks');
const notify = require('./lib/notify');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const ONCE = flag('once');
const ALL = flag('all');
const NO_INPUT = flag('no-input');

if (flag('themes')) {
  console.log('Available themes: ' + themes.names().join(', '));
  console.log('Custom themes live in ' + themes.USER_THEME_DIR + ' (<name>.json)');
  console.log('Required keys: ' + themes.REQUIRED_KEYS.join(', '));
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
  if (value('since')) c.windowMs = configLib.parseWindow(value('since'));
  if (flag('wide')) c.wide = true;
  if (flag('flat')) c.group = false;
  if (ALL) { c.showEmpty = true; c.windowMs = 0; }
  return configLib.sanitise(c);
}

let active = applyOverrides(cfg);
let theme = themes.resolve(active.theme);

// Runtime toggles from the keyboard. They sit on top of the config and are not
// written back to disk: the config file stays the user's.
const session = { all: ALL, group: null, theme: null, notifications: null, selected: 0 };

const wantAll = () => session.all;
const wantGroup = () => (session.group === null ? active.group : session.group);
const wantNotifications = () => (session.notifications === null ? active.notifications : session.notifications);

const COLOUR_ON = !process.env.NO_COLOR && (process.stdout.isTTY || ONCE);
const RESET = COLOUR_ON ? '\x1b[0m' : '';
const BOLD = COLOUR_ON ? '\x1b[1m' : '';
const REVERSE = COLOUR_ON ? '\x1b[7m' : '';
const INTERACTIVE = !ONCE && !NO_INPUT && process.stdin.isTTY && process.stdout.isTTY;

function paint(role) {
  if (!COLOUR_ON) return '';
  const rgb = themes.hexToRgb(theme.colours[role]);
  if (!rgb) return '';
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const GLYPHS = {
  ascii: { asking: '??', interrupted: '||', running: '>>', thinking: '..', done: 'OK', idle: '--' },
  emoji: { asking: '🔔', interrupted: '⏸️', running: '🔧', thinking: '💭', done: '✅', idle: '·' },
};
const glyph = (s) => (GLYPHS[active.glyphs] || GLYPHS.ascii)[s] || '·';

// --- width helpers: strip ANSI, count emoji/CJK as two cells ---------------
const ANSI = /\x1b\[[0-9;]*m/g;
function width(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI, '')) {
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
function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function compact(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// --- data ------------------------------------------------------------------
function collect() {
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
  let visible = wantAll() ? rows : rows.filter((r) => !r.empty);
  let stale = 0;
  const windowMs = wantAll() ? 0 : active.windowMs;
  if (windowMs > 0) {
    const before = visible.length;
    visible = visible.filter((r) => Date.now() - r.lastEvent < windowMs);
    stale = before - visible.length;
  }
  return { rows: visible, hiddenEmpty: wantAll() ? 0 : empty.length, hiddenStale: stale };
}

// --- rendering -------------------------------------------------------------
const FIXED = {
  status: 13, project: 16, action: 13, model: 10, branch: 14, src: 5, session: 9,
  time: 5, ctx: 10, cost: 8, tokens: 8, tasks: 7, agents: 6, effort: 7, mode: 11,
};
const HEADS = {
  status: 'STATUS', title: 'TITLE', project: 'PROJECT', action: 'ACTION',
  model: 'MODEL', branch: 'BRANCH', src: 'FROM', session: 'SESSION', time: 'AGE',
  ctx: 'CTX', cost: 'COST', tokens: 'TOKENS', tasks: 'TASKS', agents: 'AGENTS',
  effort: 'EFFORT', mode: 'MODE',
};

// The title carries the meaning, so it never shrinks below MIN_TITLE. On a
// narrow terminal, optional columns drop in this order instead.
const MIN_TITLE = 28;
const DROP_ORDER = ['mode', 'effort', 'agents', 'branch', 'tokens', 'model', 'tasks', 'ctx', 'project', 'cost', 'session', 'action', 'src'];

function layout(total, requested, indent) {
  let columns = requested.slice();
  const widthOf = (c) => (c === 'session' ? (active.wide ? 37 : FIXED.session) : FIXED[c]);
  const spent = () => columns.filter((c) => c !== 'title')
    .reduce((sum, c) => sum + widthOf(c) + 1, indent);

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

// A 1M-context session legitimately reports more than the standard window, so
// the limit follows the data rather than pretending everything is 200k.
function contextLimit(tokens) {
  const configured = Number(active.contextLimit) || 200000;
  return tokens > configured ? 1000000 : configured;
}

function cell(row, col) {
  switch (col) {
    case 'status': return `${glyph(row.status)} ${row.status}`;
    case 'title': return row.title;
    case 'project': return row.project;
    case 'action': return row.action || '—';
    case 'model': return row.model || '—';
    case 'branch': return row.branch || '—';
    case 'src': return `[${row.src}]`;
    case 'session': return active.wide ? row.sessionId : row.sessionId.slice(0, 8);
    case 'time': return ago(row.lastEvent);
    case 'ctx': {
      if (!row.contextTokens) return '—';
      const pct = Math.round((row.contextTokens / contextLimit(row.contextTokens)) * 100);
      return `${compact(row.contextTokens)} ${pct}%`;
    }
    case 'cost': return row.cost == null ? '—' : '$' + row.cost.toFixed(2);
    case 'tokens': return row.tokens == null ? '—' : compact(row.tokens);
    case 'tasks': return row.plan ? `${row.plan.completed}/${row.plan.total}` : '—';
    case 'agents': return row.agents && row.agents.total ? `${row.agents.running}/${row.agents.total}` : '—';
    case 'effort': return row.effort || '—';
    case 'mode': return row.permissionMode || '—';
    default: return '';
  }
}

function render() {
  const { rows, hiddenEmpty, hiddenStale } = collect();

  if (INTERACTIVE) {
    if (session.selected >= rows.length) session.selected = Math.max(0, rows.length - 1);
    notify.forget(new Set(rows.map((r) => r.sessionId)));
  }
  const notified = notify.check(rows, wantNotifications());

  // COLUMNS env lets a piped run (tests, CI) exercise a real terminal width.
  const detected = process.stdout.columns || Number(process.env.COLUMNS) || 100;
  const total = Math.max(60, Math.min(detected, 220));
  const grouped = wantGroup();
  const indent = grouped ? 2 : 0;
  const { w, columns: cols } = layout(total, active.columns, indent);
  const rule = paint('border') + '─'.repeat(total - 4) + RESET;

  const out = [];
  const clock = new Date().toLocaleTimeString();
  out.push(`  ${BOLD}${paint('accent')}Claude Monitor${RESET}  ${paint('dim')}${clock} · ` +
    `${rows.length} session${rows.length === 1 ? '' : 's'} · theme ${theme.name}` +
    `${theme.fallbackFrom ? ` (unknown "${theme.fallbackFrom}", using dark)` : ''}` +
    `${wantNotifications() ? ' · notify on' : ''}${RESET}`);
  out.push('  ' + rule);

  if (!rows.length) {
    const hidden = [];
    if (hiddenEmpty) hidden.push(`${hiddenEmpty} empty`);
    if (hiddenStale) hidden.push(`${hiddenStale} stale`);
    out.push(`  ${paint('dim')}Nothing to show${hidden.length ? ` (${hidden.join(', ')} hidden — press a or --all)` : ''}.${RESET}`);
    return out.join('\n');
  }

  const header = (lead) => `  ${BOLD}${paint('header')}${lead}` +
    cols.map((c) => pad(HEADS[c], w[c])).join(' ') + RESET;

  let index = 0;
  const line = (row, lead) => {
    const isSelected = INTERACTIVE && index === session.selected;
    index++;
    const colour = paint(row.status) || paint('idle');
    const needsYou = row.status === 'asking' || row.status === 'interrupted';
    const parts = cols.map((c) => {
      const text = pad(cell(row, c), w[c]);
      if (c === 'status') return colour + (needsYou ? BOLD : '') + text + RESET;
      if (c === 'title') return (needsYou ? BOLD + colour : '') + text + RESET;
      return paint('dim') + text + RESET;
    });
    const extras = [];
    if (row.queued) extras.push(`${colour}+${row.queued} queued${RESET}`);
    if (row.plan && row.plan.current) extras.push(`${paint('dim')}▸ ${clip(row.plan.current, 28)}${RESET}`);
    const body = lead + parts.join(' ') + (extras.length ? ' ' + extras.join(' ') : '');
    return '  ' + (isSelected ? REVERSE + body.replace(ANSI, '') + RESET : body);
  };

  if (!grouped) {
    out.push(header(''));
    out.push('  ' + rule);
    for (const r of rows) out.push(line(r, ''));
  } else {
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.project)) groups.set(r.project, []);
      groups.get(r.project).push(r);
    }
    out.push(header('  '));
    out.push('  ' + rule);
    for (const [project, group] of groups) {
      out.push(`  ${BOLD}${paint('header')}${project}${RESET}${paint('dim')} · ${group.length}${RESET}`);
      for (const r of group) out.push(line(r, '  '));
    }
  }

  out.push('  ' + rule);
  const sources = {};
  for (const r of rows) sources[r.titleSource] = (sources[r.titleSource] || 0) + 1;
  const hidden = [];
  if (hiddenEmpty) hidden.push(`${hiddenEmpty} empty`);
  if (hiddenStale) hidden.push(`${hiddenStale} stale`);
  const dropped = active.columns.filter((c) => !cols.includes(c));
  out.push(`  ${paint('dim')}titles ${Object.entries(sources).map(([k, v]) => `${k}:${v}`).join(' · ')}` +
    `${hidden.length ? ` · hidden ${hidden.join(', ')}` : ''}` +
    `${dropped.length ? ` · narrow, dropped ${dropped.join(', ')}` : ''}` +
    `${notified ? ` · ${notified} notification${notified > 1 ? 's' : ''} sent` : ''}${RESET}`);
  if (!ONCE) {
    out.push(INTERACTIVE
      ? `  ${paint('dim')}↑↓ select · enter VS Code · e explorer · c copy id · a all · g group · t theme · n notify · q quit${RESET}`
      : `  ${paint('dim')}${active.refreshMs / 1000}s refresh · config ${configLib.FILE}${created.created ? ' (created)' : ''} · Ctrl+C to exit${RESET}`);
  }
  return out.join('\n');
}

// Flicker-free: home the cursor and clear to end of line rather than wiping the
// screen every frame.
let previousLines = 0;
let lastRows = [];
function draw() {
  const text = render();
  if (ONCE) {
    process.stdout.write(text + '\n');
    return;
  }
  const lines = text.split('\n');
  process.stdout.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[K');
  if (lines.length < previousLines) process.stdout.write('\n\x1b[J');
  previousLines = lines.length;
}

// --- actions on the selected row -------------------------------------------
function selectedRow() {
  const { rows } = collect();
  lastRows = rows;
  return rows[session.selected] || null;
}

function openInVsCode(row) {
  if (!row || !row.cwd) return;
  try {
    spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'code', '-r', row.cwd],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { /* ignore */ }
}

function openInExplorer(row) {
  if (!row || !row.cwd) return;
  try {
    spawn('explorer.exe', [row.cwd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { /* ignore */ }
}

function copyId(row) {
  if (!row) return;
  try {
    const child = spawn('clip.exe', { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.stdin.end(row.sessionId);
  } catch (e) { /* ignore */ }
}

function cycleTheme() {
  const list = themes.names();
  const at = list.indexOf(theme.name);
  session.theme = list[(at + 1) % list.length];
  active = applyOverrides({ ...cfg, theme: session.theme });
  theme = themes.resolve(active.theme);
}

// --- main ------------------------------------------------------------------
if (ONCE) {
  draw();
  ccboard.close();
} else {
  process.stdout.write('\x1b[2J');
  draw();

  let timer = setInterval(draw, active.refreshMs);

  const unwatch = configLib.watch((next) => {
    cfg = next;
    const previousRefresh = active.refreshMs;
    active = applyOverrides(session.theme ? { ...cfg, theme: session.theme } : cfg);
    theme = themes.resolve(active.theme);
    if (active.refreshMs !== previousRefresh) {
      clearInterval(timer);
      timer = setInterval(draw, active.refreshMs);
    }
    process.stdout.write('\x1b[2J');
    previousLines = 0;
    draw();
  });

  const quit = () => {
    clearInterval(timer);
    unwatch();
    ccboard.close();
    if (INTERACTIVE) {
      try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
      process.stdin.pause();
    }
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  };

  process.stdout.on('resize', () => { process.stdout.write('\x1b[2J'); previousLines = 0; draw(); });
  process.on('SIGINT', quit);

  if (INTERACTIVE) {
    process.stdout.write('\x1b[?25l');   // hide the cursor while navigating
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      const rows = lastRows.length ? lastRows : collect().rows;
      switch (key) {
        case '': case 'q': return quit();
        case '[A': case 'k': session.selected = Math.max(0, session.selected - 1); break;
        case '[B': case 'j': session.selected = Math.min(rows.length - 1, session.selected + 1); break;
        case '\r': case '\n': openInVsCode(selectedRow()); break;
        case 'e': openInExplorer(selectedRow()); break;
        case 'c': copyId(selectedRow()); break;
        case 'a': session.all = !session.all; session.selected = 0; break;
        case 'g': session.group = !wantGroup(); break;
        case 't': cycleTheme(); break;
        case 'n': session.notifications = !wantNotifications(); break;
        default: return;
      }
      draw();
    });
  }
}
