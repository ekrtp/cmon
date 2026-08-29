#!/usr/bin/env node
// Claude Code session monitor — fork (ekrtp), upstream: ibrahimokdadov/claudeMonitor
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
//   node monitor.js --themes            list themes and exit
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

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const ONCE = flag('once');
const ALL = flag('all');

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
function compactNumber(n) {
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
const DROP_ORDER = ['mode', 'branch', 'agents', 'tokens', 'effort', 'tasks', 'project',
  'model', 'session', 'focus', 'ctx', 'cost', 'action', 'src'];

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
    case 'focus': return row.focus ? row.focus.name + (row.focus.confident ? '' : ' ?') : '—';
    case 'action': return row.action || '—';
    case 'model': return row.model || '—';
    case 'branch': return row.branch || '—';
    case 'src': return `[${row.src}]`;
    case 'session': return active.wide ? row.sessionId : row.sessionId.slice(0, 8);
    case 'time': return ago(row.lastEvent);
    case 'ctx': {
      if (!row.contextTokens) return '—';
      const pct = Math.round((row.contextTokens / contextLimit(row.contextTokens)) * 100);
      return `${compactNumber(row.contextTokens)} ${pct}%`;
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
  const clock = new Date().toLocaleTimeString();
  out.push(`  ${BOLD}${paint('accent')}Claude Monitor${RESET}  ${paint('dim')}${clock} · ` +
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

  const line = (row, lead) => {
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
    if (row.plan && row.plan.current) extras.push(`${paint('dim')}▸ ${clip(row.plan.current, 30)}${RESET}`);
    return '  ' + lead + parts.join(sep) + (extras.length ? sep + extras.join(' ') : '');
  };

  if (!grouped) {
    out.push(header(''));
    out.push('  ' + rule);
    for (const r of rows) out.push(line(r, ''));
  } else {
    out.push(header('  '));
    out.push('  ' + rule);
    for (const group of grouped) {
      const label = active.groupBy === 'status'
        ? (STATUS_HEADING[group.key] || group.key)
        : group.key;
      const colour = active.groupBy === 'status' ? (paint(group.key) || paint('header')) : paint('header');
      out.push(`  ${BOLD}${colour}${label}${RESET}${paint('dim')} · ${group.rows.length}${RESET}`);
      for (const r of group.rows) out.push(line(r, '  '));
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
    out.push(`  ${paint('dim')}watching · ${active.refreshMs / 1000}s refresh · grouped by ${active.groupBy} · ` +
      `config ${configLib.FILE}${created.created ? ' (created)' : ''} · Ctrl+C to exit${RESET}`);
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

  process.on('SIGINT', () => {
    clearInterval(dataTimer);
    if (animTimer) clearInterval(animTimer);
    unwatch();
    ccboard.close();
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  });
}
