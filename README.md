# claudeMonitor (fork)

A terminal monitor for your Claude Code sessions on Windows: **one row per
session**, the **title you actually gave it**, a status read from the session
transcript, and what each session is costing you.

Fork of [ibrahimokdadov/claudeMonitor](https://github.com/ibrahimokdadov/claudeMonitor).
No dependencies — Node built-ins only.

```
  Claude Monitor  08:39:36 · 4 sessions · theme dark · notify on
  ──────────────────────────────────────────────────────────────────────────────────────────
    STATUS        TITLE                              CTX        COST     TASKS  FROM  AGE
  ──────────────────────────────────────────────────────────────────────────────────────────
  VSCode · 4
    >> running    claudeMonitor fork to ekrtp        283k 28%   $1.42    3/7    [vsc] 2s   ▸ Wiring the theme system
    .. thinking   Notes vault klasörü düzenlemesi  114k 57%   $0.61    —      [vsc] 49s
    OK done       project-a: cache-layer              872k 87%   $24.74   —      [vsc] 1h
    ?? asking     project-c article summary            48k 24%    $0.08    2/3    [cli] 3s   +1 queued
  ──────────────────────────────────────────────────────────────────────────────────────────
  titles ai-title:3 · user:1 · hidden 1 empty
  ↑↓ select · enter VS Code · e explorer · c copy id · a all · g group · t theme · n notify · q quit
```

## Install

```powershell
git clone <this fork> claudeMonitor
cd claudeMonitor
node monitor.js
```

Nothing is installed, no hooks are registered, `settings.json` is never touched,
and nothing is written into Claude Code's own directories. Everything on screen
comes from files that already exist.

## Usage

| Command | What it does |
|---|---|
| `node monitor.js` | live table; interactive when run on a terminal |
| `node monitor.js --once` | render once and exit (scripts, CI) |
| `node monitor.js --all` | include empty chat tabs and stale sessions |
| `node monitor.js --since=30m` | only sessions active in the last 30 minutes |
| `node monitor.js --theme=light` | override the configured theme |
| `node monitor.js --glyphs=emoji` | emoji status glyphs instead of ASCII |
| `node monitor.js --columns=status,title,cost,time` | pick your columns |
| `node monitor.js --wide` / `--flat` / `--no-input` | full session id · no grouping · no keyboard |
| `node monitor.js --themes` | list themes and exit |
| `npm test` | 56 fixture assertions, no network, no deps |
| `npm run config` | show or edit the config (see below) |
| `npm run probe` / `npm run fields` | re-measure the data sources into `docs/` |

`NO_COLOR=1` disables colour; colour also switches off when stdout is not a TTY.

### Keys

| Key | Action |
|---|---|
| `↑` `↓` or `k` `j` | move the selection |
| `Enter` | open that session's folder in VS Code (`code -r`) |
| `e` | open the folder in Explorer |
| `c` | copy the session id to the clipboard |
| `a` | toggle empty/stale sessions |
| `g` | toggle project grouping |
| `t` | cycle themes |
| `n` | toggle notifications |
| `q` or `Ctrl+C` | quit |

Keyboard toggles are for this run only — your config file is never rewritten
behind your back.

## Statuses

| Status | Colour | Derived from |
|---|---|---|
| `asking` | yellow | an `AskUserQuestion` call, or a permission denial that is still the newest event |
| `interrupted` | yellow | `[Request interrupted by user]` in the transcript |
| `running` | blue | `stop_reason: "tool_use"` — a tool is executing; ACTION names it |
| `thinking` | purple | the newest line is a user turn or a tool result |
| `done` | green | `stop_reason: "end_turn"` — the turn finished |
| `idle` | grey | nothing recent, or a "running" tool older than `idleAfterMs` |

Rows sort by how much they want from you: `asking` first, `idle` last. Sub-agent
turns (`isSidechain`) never decide the session's own status.

## Where the title comes from

1. **A name you gave the session** — from the ccboard dashboard database
   (`~/.claude/agent-dashboard/dashboard.db`, `sessions.name`). Renaming a
   session never reaches Claude Code's own files, which is why tools that read
   only `~/.claude/sessions` keep showing a stale title.
2. **`ai-title`** from the transcript.
3. **The first non-meta user message** — IDE notifications, slash-command output
   and `<tag>`-wrapped turns are skipped.
4. **`firstPrompt`** recorded by the optional hook.
5. **Project name + short session id.**

The footer says which source each row used. Two sessions that resolve to the
same title get their short id appended rather than looking like duplicates.

## Columns

`status`, `title`, `project`, `action`, `model`, `branch`, `src`, `session`,
`time`, `ctx`, `cost`, `tokens`, `tasks`, `agents`, `effort`, `mode`.

| Column | Meaning | Source |
|---|---|---|
| `ctx` | context occupancy, e.g. `283k 28%` | newest `usage`: input + cache read + cache creation |
| `cost` | money spent by this session | `token_usage` × `model_pricing` in dashboard.db |
| `tokens` | all tokens including cache reads | dashboard.db |
| `tasks` | plan progress, e.g. `3/7`, plus the task in flight | `~/.claude/tasks/<session>/*.json` |
| `agents` | running / total sub-agents | dashboard.db `agents` |
| `effort` / `mode` | reasoning effort · permission mode | transcript |

On a narrow terminal, columns drop in a fixed order rather than squeezing the
title; the footer tells you which ones went.

## Configuration

`~/.claude/monitor/config.json`, created on first run and **hot-reloaded** —
edit it while the monitor runs and the next frame picks it up.

```powershell
node scripts/config.js                      # show current config
node scripts/config.js set theme solarized
node scripts/config.js set notifications true
node scripts/config.js columns +cost -branch
node scripts/config.js columns status,title,cost,time
node scripts/config.js defaults             # rewrite with defaults
```

Every change writes a timestamped backup next to the file first.

```json
{
  "theme": "dark",
  "glyphs": "ascii",
  "columns": ["status", "title", "action", "model", "ctx", "cost", "tasks", "src", "session", "time"],
  "refreshMs": 2000,
  "window": "4h",
  "showEmpty": false,
  "group": true,
  "wide": false,
  "idleAfterMs": 120000,
  "contextLimit": 200000,
  "notifications": false
}
```

### Themes

Built in: `dark`, `light`, `solarized`, `mono` (no colour). Add your own as
`~/.claude/monitor/themes/<name>.json`:

```json
{
  "running": "#7aa2f7", "thinking": "#bb9af7", "done": "#9ece6a",
  "asking": "#e0af68", "interrupted": "#e0af68", "idle": "#565f89",
  "header": "#c0caf5", "dim": "#565f89", "accent": "#e0af68", "border": "#3b4261"
}
```

Missing keys fall back to `dark`, so a partial theme still renders. An unknown
theme name falls back to `dark` and says so in the header.

### Notifications

`"notifications": true` (or press `n`) shows a Windows balloon tip when a session
moves into `asking` or `interrupted`. It fires on the transition only, never on
the first frame, and at most once a minute per session.

## Hooks (optional)

The monitor does not need hooks. Installing them only adds the prompt at submit
time and Notification events:

```powershell
node scripts/install-hooks.js --dry-run   # show what would change
node scripts/install-hooks.js             # back up, merge, write
node scripts/uninstall-hooks.js           # remove only ours
```

The installer **merges**: other tools' hooks are preserved (measured on the
author's machine: 18 hook commands belonging to a different app), it is
idempotent, and it writes a timestamped backup of `settings.json` first. If you
switch accounts with a tool that swaps `~/.claude`, run it again.

## What it reads

| Path | Use | Mode |
|---|---|---|
| `~/.claude/sessions/<PID>.json` | which sessions exist (pid, id, cwd, entrypoint) | read only |
| `~/.claude/projects/<enc>/<id>.jsonl` | title, status, model, branch, context, queue | read only, windowed |
| `~/.claude/agent-dashboard/dashboard.db` | curated names, cost, sub-agents | read only, optional |
| `~/.claude/tasks/<session>/*.json` | plan progress | read only |
| `~/.claude/monitor/config.json` | configuration | read + created once |
| `~/.claude/monitor/state/<id>.json` | optional hook state | written by the hook |
| `~/.claude/claude-monitor-status/*.json` | legacy state from an older install | read only |

Transcripts are never loaded whole: 128 KB from the head for the title, 64 KB
from the tail for the status, cached per file mtime, and a resolved `ai-title` is
cached permanently. Measured over 33 live sessions: 91 ms cold, 6–9 ms warm.

## Differences from upstream

- Rows are keyed by **session**, not by project directory. Upstream wrote
  `~/.claude/sessions/<project>.json`, so every chat in a workspace overwrote the
  same file — one row for N chats, and one session duplicated across every
  directory it had `cd`'d into.
- Nothing is written into `~/.claude/sessions/`, which is Claude Code's own
  registry.
- Titles, statuses and metadata come from the transcript and the dashboard
  database. `decodeDirName()` is gone (it turned `e-commerce` into
  `e\commerce`); the real `cwd` is encoded instead.
- No `powershell.exe` spawn every 2 seconds: liveness is `process.kill(pid, 0)`.
- Themes with hot reload, configurable and responsive columns, cost and context
  columns, keyboard navigation, flicker-free redraw, and a fixture test suite.

`docs/DATA-SOURCES.md` records what was measured about each file format — Claude
Code can change them, and that file is the evidence this code rests on.

## Notes

- Windows-first by design; platform code is confined to `lib/platform/win32.js`.
- The dashboard database is read with `node:sqlite` (Node 22.5+). Without it,
  names, cost and sub-agent counts simply go quiet.
- Upstream has no LICENSE file. This is a personal fork; ask the original author
  about licensing before publishing anything built on it.
