// Plan limits for the usage bar: the 5-hour limit ("Stamina"), the weekly limit
// ("HP") and any model-scoped weekly limit as an extra meter.
//
// The numbers come from `cswap list --json` (claude-swap). cmon holds no token
// and makes no network call itself: cswap polls Anthropic's usage endpoint on
// its own schedule and answers from its cache in between, so asking it every
// minute is cheap. Without cswap installed there is simply no bar.
//
// Only the active account is read, and only numbers, times and a model name are
// kept: the account's email and organization never leave this file.
//
// Two layers, so a passed reset shows as refilled even when cswap is down:
//   extract(raw)    whitelist the fields, once per poll       (what is stored)
//   normalise(x,n)  everything that depends on the clock      (run on every read)

const { execFile, execFileSync } = require('child_process');

const POLL_MS = 60000;
const MISSING_RETRY_MS = 10 * 60000;
const LOW_LEFT = 20;
// A model-scoped limit's icon; a model not listed here gets a sparkle.
const SCOPED_ICONS = { fable: '📖' };

const bin = () => process.env.CLAUDE_MONITOR_CSWAP || 'cswap';
const off = () => bin() === 'off';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function time(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// One limit window as cswap reports it, reduced to what the bar needs. A window
// without a numeric pct is no window at all.
function windowOf(src, base) {
  if (!isObj(src)) return null;
  const pct = num(src.pct);
  if (pct === null) return null;
  return {
    ...base,
    pct: Math.round(clamp(pct, 0, 100)),
    resetsAt: time(src.resetsAt),
    expectedPct: num(src.expectedPct),
    projectedExhaustionAt: time(src.projectedExhaustionAt),
    willLastToReset: src.willLastToReset === true ? true : (src.willLastToReset === false ? false : null),
  };
}

function scopedName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
}

// cswap's JSON in, the whitelisted raw form out. null when there is no active
// account or nothing usable in it. Never throws.
function extract(json) {
  try {
    if (!isObj(json) || !Array.isArray(json.accounts)) return null;
    const accounts = json.accounts.filter(isObj);
    const acct = accounts.find((a) => a.active === true) ||
      accounts.find((a) => a.number !== undefined && a.number === json.activeAccountNumber);
    if (!acct) return null;

    let stale = false;
    let usage = isObj(acct.usage) ? acct.usage : null;
    let fetchedAt = time(acct.usageFetchedAt);
    if (!usage && isObj(acct.lastGoodUsage)) {
      usage = acct.lastGoodUsage;
      fetchedAt = time(acct.lastGoodFetchedAt);
      stale = true;
    }
    if (!usage) return null;

    const windows = [];
    const stamina = windowOf(usage.fiveHour, { key: 'stamina', label: 'Stamina', icon: '⚡', window: '5h' });
    const hp = windowOf(usage.sevenDay, { key: 'hp', label: 'HP', icon: '❤️', window: 'week' });
    if (stamina) windows.push(stamina);
    if (hp) windows.push(hp);
    if (Array.isArray(usage.scoped)) {
      for (const s of usage.scoped) {
        if (!isObj(s)) continue;
        const name = scopedName(s.name);
        if (!name) continue;
        const w = windowOf(s, { key: 'scoped:' + name, label: name, icon: SCOPED_ICONS[name.toLowerCase()] || '✨', window: 'week' });
        if (w) windows.push(w);
      }
    }
    if (!windows.length) return null;
    return { account: num(acct.number), fetchedAt, stale, windows };
  } catch (e) {
    return null;
  }
}

function statusOf(meters) {
  const hp = meters.find((m) => m.key === 'hp');
  const stamina = meters.find((m) => m.key === 'stamina');
  const scoped = meters.filter((m) => m.key.startsWith('scoped:'));
  if (hp && hp.left === 0) return { kind: 'ko', label: 'HP', at: hp.resetsAt };
  if (stamina && stamina.left === 0) return { kind: 'winded', label: 'Stamina', at: stamina.resetsAt };
  const dry = scoped.find((m) => m.left === 0);
  if (dry) return { kind: 'drained', label: dry.label, at: dry.resetsAt };
  if (hp && hp.runsOutAt) return { kind: 'burning', label: 'HP', at: hp.runsOutAt };
  const burning = scoped.find((m) => m.runsOutAt);
  if (burning) return { kind: 'burning', label: burning.label, at: burning.runsOutAt };
  if (stamina && stamina.left <= LOW_LEFT) return { kind: 'low', label: 'Stamina', at: stamina.resetsAt };
  return { kind: 'steady', label: 'HP', at: null };
}

// The clock-dependent half. A window whose reset time has passed has refilled,
// whatever the stored percentage says.
function normalise(parsed, now) {
  if (!parsed || !Array.isArray(parsed.windows)) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const meters = parsed.windows.map((w) => {
    const reset = w.resetsAt !== null && w.resetsAt <= t;
    const pct = reset ? 0 : w.pct;
    const runsOut = !reset && w.willLastToReset === false && w.projectedExhaustionAt !== null &&
      w.projectedExhaustionAt > t;
    return {
      key: w.key, label: w.label, icon: w.icon, window: w.window,
      pct,
      left: 100 - pct,
      resetsAt: reset ? null : w.resetsAt,
      expectedLeft: reset || w.expectedPct === null ? null : Math.round(100 - clamp(w.expectedPct, 0, 100)),
      runsOutAt: runsOut ? w.projectedExhaustionAt : null,
    };
  });
  return {
    account: parsed.account,
    fetchedAt: parsed.fetchedAt,
    stale: !!parsed.stale,
    meters,
    status: statusOf(meters),
  };
}

function parse(json, now) {
  return normalise(extract(json), now);
}

// "12m" under an hour, "4h 8m" under a day, "4d 16h" beyond. Minutes round up so
// a live countdown never reads 0m early.
function until(ms, now) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const t = Number.isFinite(now) ? now : Date.now();
  const diff = ms - t;
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

const defaultTime = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');

// The one-line verdict under the meters. fmtTime turns a ms time into "Sat 21:53".
function statusText(usage, now, fmtTime) {
  const s = usage && usage.status;
  if (!s) return '';
  const back = s.at ? until(s.at, now) : '';
  switch (s.kind) {
    case 'ko': return back ? `K.O. HP respawns in ${back}` : 'K.O. HP is out';
    case 'winded': return back ? `Out of stamina, back in ${back}` : 'Out of stamina';
    case 'drained': return back ? `${s.label} is out, back in ${back}` : `${s.label} is out`;
    case 'burning': return `${s.label} runs out ${(fmtTime || defaultTime)(s.at)} at this pace`;
    case 'low': return back ? `Low stamina, refills in ${back}` : 'Low stamina';
    default: return 'On pace, HP lasts to reset';
  }
}

// --- polling ---------------------------------------------------------------
// One instance per process. `raw` is the last good extract; `failed` means the
// newest attempt did not produce data, so what we hold is old.
let raw = null;
let failed = false;
let started = false;
let busy = false;

// Fold one cswap answer into the state. Returns 'missing' when cswap is not
// installed, so the caller can back off.
function apply(err, stdout) {
  if (err) {
    if (err.code === 'ENOENT') { raw = null; failed = false; return 'missing'; }
    failed = true;
    return 'failed';
  }
  let next = null;
  try { next = extract(JSON.parse(String(stdout))); } catch (e) { next = null; }
  if (!next) { failed = true; return 'failed'; }
  raw = next;
  failed = false;
  return 'ok';
}

const OPTIONS = { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 };

function start(opts) {
  const enabled = opts && typeof opts.enabled === 'function' ? opts.enabled : () => true;
  if (started || off()) return;
  started = true;

  const schedule = (ms) => setTimeout(poll, ms).unref();
  const poll = () => {
    let on = true;
    try { on = enabled(); } catch (e) { on = true; }
    if (!on || off() || busy) return schedule(POLL_MS);
    busy = true;
    execFile(bin(), ['list', '--json'], { ...OPTIONS, timeout: 20000 }, (err, stdout) => {
      busy = false;
      schedule(apply(err, stdout) === 'missing' ? MISSING_RETRY_MS : POLL_MS);
    });
  };
  poll();
}

// Synchronous, for --once. Never throws.
function fetchOnce() {
  if (off()) return;
  try {
    const stdout = execFileSync(bin(), ['list', '--json'], { ...OPTIONS, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    apply(null, stdout);
  } catch (e) {
    apply(e, '');
  }
}

// What the bars show now. The same JSON on every call until the data or a reset
// boundary changes: no ages in here, the web server only pushes on a change.
function current(now) {
  if (!raw) return null;
  return normalise({ ...raw, stale: raw.stale || failed }, now === undefined ? Date.now() : now);
}

// Test hooks: feed the state machine a cswap answer without spawning anything.
const _apply = apply;
const _reset = () => { raw = null; failed = false; };

module.exports = { parse, normalise, until, statusText, start, fetchOnce, current, _apply, _reset };
