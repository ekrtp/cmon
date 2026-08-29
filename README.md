# claudeMonitor (fork)

A read-only wall display for your Claude Code sessions on Windows: **one row per
session**, the **title you actually gave it**, a status read from the session
transcript, what each session is costing you, and which project it is really
about.

It watches; it never drives. No keyboard, no navigation, no hooks, and nothing
written into Claude Code's own directories.

Fork of [ibrahimokdadov/claudeMonitor](https://github.com/ibrahimokdadov/claudeMonitor).
No dependencies — Node built-ins only.

```
  Claude Monitor  10:22:31 · 4 sessions · theme cswap
  ──────────────────────────────────────────────────────────────────────────────────────────────────────

    STATUS         TITLE                          MODEL     EFFORT  CTX        COST     TASKS  FOCUS
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
  waiting for you · 1
    !! asking      project-c article summary        opus-5    high    48k 24%    $0.08    2/3    project-c

  running a tool · 1
    /> running     claudeMonitor fork to ekrtp    opus-5    high    353k 35%   $1.42    3/7    personal-folder

  finished · 2
    OK done        project-a: cache-layer          opus-5    high    872k 87%   $24.74   —      project-a
    OK done        Notes vault klasörü düzen…   opus-5    high    211k 21%   $3.10    —      notes-vault
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
  titles ai-title:3 · user:1 · hidden 1 empty
  watching · 2s refresh · grouped by status · Ctrl+C to exit
```

## Install

```powershell
git clone <this fork> claudeMonitor
cd claudeMonitor
node monitor.js
```

## Usage

| Command | What it does |
|---|---|
| `node monitor.js` | live table |
| `node monitor.js --once` | render once and exit (scripts, CI) |
| `node monitor.js --all` | include empty chat tabs and stale sessions |
| `node monitor.js --since=30m` | only sessions active in the last 30 minutes |
| `node monitor.js --theme=nord` | override the configured theme |
| `node monitor.js --group=focus` | group by `status` (default), `focus`, `project` or `none` |
| `node monitor.js --compact` | tighter rows |
| `node monitor.js --no-animation` | hold the status glyphs still |
| `node monitor.js --glyphs=emoji` | emoji glyphs and a braille spinner |
| `node monitor.js --columns=status,title,cost,time` | pick your columns |
| `node monitor.js --wide` | full session id |
| `node monitor.js --themes` | list themes and exit |
| `npm test` | 68 fixture assertions, no network, no deps |
| `npm run config` | show or edit the config |
| `npm run probe` / `npm run fields` | re-measure the data sources into `docs/` |

`NO_COLOR=1` disables colour; colour also switches off when stdout is not a TTY.

## Statuses

| Status | Colour | Derived from |
|---|---|---|
| `asking` | yellow, slow pulse | an `AskUserQuestion` call, or a permission denial that is still the newest event |
| `interrupted` | red | `[Request interrupted by user]` in the transcript |
| `running` | signature colour, spinner | `stop_reason: "tool_use"` — a tool is executing; ACTION names it |
| `thinking` | second accent, spinner | the newest line is a user turn or a tool result |
| `done` | green | `stop_reason: "end_turn"` — the turn finished |
| `idle` | grey | nothing recent, or a "running" tool older than `idleAfterMs` |

Rows sort by how much they want from you, and by default they are **grouped by
status** with a heading per bucket (`waiting for you`, `running a tool`,
`finished`, …). Sub-agent turns (`isSidechain`) never decide the session's own
status.

Only the two live states animate, at `animationMs` (220 ms by default), and the
animation never touches the disk — it repaints the last snapshot while data is
re-read on the slower `refreshMs` clock.

## Which project is a session about?

Every VS Code chat in one workspace reports the same `cwd`, so grouping by
directory puts everything in one bucket. The `focus` column answers the real
question:

1. Walk up from the session's `cwd` to the nearest `CLAUDE.md` — that is the
   workspace root. Its folder links are the project list, unioned with the
   root's actual sub-directories (a router file is allowed to lag).
2. Score those names against the transcript. A **path** mention
   (`project-c/veri-kesfi`, `informations\connections`) counts three times a bare
   mention in prose, each line contributes at most four hits, and the tail of
   the conversation counts double — what a session is doing now outranks how it
   opened.
3. Show the winner only if it clears a floor and beats the runner-up by 1.5×.
   Otherwise the cell stays `—`, or shows the name with a `?` when the margin is
   thin.

Recomputed every 30 seconds per session, and only when the transcript changed.
Measured on this machine: `personal-folder` 241 vs 28, `project-a` 250 vs 78,
`notes-vault` 494 vs 18.

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

`status`, `title`, `project`, `focus`, `action`, `model`, `branch`, `src`,
`session`, `time`, `ctx`, `cost`, `tokens`, `tasks`, `agents`, `effort`, `mode`.

| Column | Meaning | Source |
|---|---|---|
| `ctx` | context occupancy, e.g. `353k 35%` | newest `usage`: input + cache read + cache creation |
| `cost` | money spent by this session | `token_usage` × `model_pricing` in dashboard.db |
| `tokens` | all tokens including cache reads | dashboard.db |
| `tasks` | plan progress, e.g. `3/7`, plus the task in flight after `▸` | `~/.claude/tasks/<session>/*.json` |
| `agents` | running / total sub-agents | dashboard.db `agents` |
| `focus` | which project the conversation is about | CLAUDE.md + transcript scoring |
| `effort` / `mode` | reasoning effort · permission mode | transcript |

On a narrow terminal, columns drop in a fixed order rather than squeezing the
title; the footer names the ones that went.

## Configuration

`~/.claude/monitor/config.json`, created on first run and **hot-reloaded** —
edit it while the monitor runs and the next frame picks it up.

```powershell
node scripts/config.js                      # show current config
node scripts/config.js set theme cswap
node scripts/config.js set groupBy focus
node scripts/config.js set density compact
node scripts/config.js set animationMs 0    # hold the glyphs still
node scripts/config.js columns +agents -tasks
node scripts/config.js defaults             # rewrite with defaults
```

Every change writes a timestamped backup next to the file first.

```json
{
  "theme": "dark",
  "glyphs": "ascii",
  "columns": ["status", "title", "action", "model", "effort", "ctx", "cost", "tasks", "focus", "src", "time"],
  "refreshMs": 2000,
  "animationMs": 220,
  "density": "comfortable",
  "groupBy": "status",
  "window": "4h",
  "showEmpty": false,
  "wide": false,
  "idleAfterMs": 120000,
  "contextLimit": 200000,
  "notifications": false
}
```

### Themes

Sixteen built in: `dark`, `light`, `cswap`, `cswap-light`, `solarized`,
`solarized-light`, `nord`, `gruvbox`, `dracula`, `catppuccin`,
`catppuccin-latte`, `one-dark`, `rose-pine`, `ayu`, `monokai`, `github-light`,
and `mono` (no colour).

`cswap` and `cswap-light` are adapted from
[claude-swap](https://pypi.org/project/claude-swap/)'s own TUI theme
(`claude_swap/tui/theme.py`): its terracotta accent `#d7875f` (xterm 173) and
the desaturated severity ramp it uses for usage bars.

Add your own as `~/.claude/monitor/themes/<name>.json`:

```json
{
  "running": "#7aa2f7", "thinking": "#bb9af7", "done": "#9ece6a",
  "asking": "#e0af68", "interrupted": "#f7768e", "idle": "#565f89",
  "header": "#c0caf5", "dim": "#565f89", "accent": "#e0af68", "border": "#3b4261"
}
```

Missing keys fall back to `dark`, so a partial theme still renders. An unknown
theme name falls back to `dark` and says so in the header.

### Notifications

`"notifications": true` shows a Windows balloon tip when a session moves into
`asking` or `interrupted`. It fires on the transition only, never on the first
frame, and at most once a minute per session.

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
idempotent, and it backs up `settings.json` first. If you switch accounts with a
tool that swaps `~/.claude`, run it again.

## What it reads

| Path | Use | Mode |
|---|---|---|
| `~/.claude/sessions/<PID>.json` | which sessions exist (pid, id, cwd, entrypoint) | read only |
| `~/.claude/projects/<enc>/<id>.jsonl` | title, status, model, context, focus, queue | read only, windowed |
| `~/.claude/agent-dashboard/dashboard.db` | curated names, cost, sub-agents | read only, optional |
| `~/.claude/tasks/<session>/*.json` | plan progress | read only |
| `<workspace>/CLAUDE.md` | the project list for `focus` | read only |
| `~/.claude/monitor/config.json` | configuration | read + created once |
| `~/.claude/monitor/state/<id>.json` | optional hook state | written by the hook |

Transcripts are never loaded whole: 128 KB from the head for the title, 64 KB
from the tail for the status, 32 KB + 192 KB for the focus scan, all cached per
file mtime, and a resolved `ai-title` is cached permanently. Measured over 33
live sessions: 91 ms cold, 6–9 ms warm.

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
- Sixteen themes with hot reload, status grouping, cost/context/focus columns,
  a subtle spinner, flicker-free redraw, and a fixture test suite.

`docs/DATA-SOURCES.md` records what was measured about each file format — Claude
Code can change them, and that file is the evidence this code rests on.

## Notes

- Windows-first by design; platform code is confined to `lib/platform/win32.js`.
- The dashboard database is read with `node:sqlite` (Node 22.5+). Without it,
  names, cost and sub-agent counts simply go quiet.
- Upstream has no LICENSE file. This is a personal fork; ask the original author
  about licensing before publishing anything built on it.
