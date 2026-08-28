# claudeMonitor (fork)

A terminal monitor for your Claude Code sessions on Windows: **one row per
session**, the **title you actually gave it**, and a status read from the
session transcript instead of guessed from hook side effects.

Fork of [ibrahimokdadov/claudeMonitor](https://github.com/ibrahimokdadov/claudeMonitor).
No dependencies — Node built-ins only.

```
  Claude Monitor  22:36:47 · 4 sessions · theme dark
  ────────────────────────────────────────────────────────────────────────────────────
    STATUS        TITLE                                ACTION   MODEL    BRANCH  FROM
  ────────────────────────────────────────────────────────────────────────────────────
  VSCode · 4
    >> running    claudeMonitor fork to ekrtp          Bash     opus-5   main    [vsc]
    .. thinking   project-a: cache-layer                Bash     opus-5   main    [vsc]
    OK done       project-a: yetkiler            —        opus-5   main    [vsc]
    ?? asking     project-c article summary              Ask…     opus-5   main    [cli]
  ────────────────────────────────────────────────────────────────────────────────────
  titles ai-title:2 · user:2 · hidden 1 stale (--all)
```

## Install

```powershell
git clone <this fork> claudeMonitor
cd claudeMonitor
node monitor.js
```

No hooks, no `settings.json` edits, nothing written to Claude Code's own
directories. Everything on screen comes from reading files Claude Code already
writes.

## Usage

| Command | What it does |
|---|---|
| `node monitor.js` | live table, refresh interval from the config (2s default) |
| `node monitor.js --once` | render once and exit (good for scripts) |
| `node monitor.js --all` | include empty chat tabs and stale sessions |
| `node monitor.js --since=30m` | only sessions active in the last 30 minutes |
| `node monitor.js --theme=light` | override the configured theme |
| `node monitor.js --glyphs=emoji` | emoji status glyphs instead of ASCII |
| `node monitor.js --columns=status,title,time` | pick your columns |
| `node monitor.js --wide` | full session id |
| `node monitor.js --flat` | no project grouping |
| `node monitor.js --themes` | list themes and exit |
| `npm test` | fixture tests (41 assertions, no network, no deps) |
| `npm run probe` | re-measure the data sources into `docs/DATA-SOURCES.md` |

`NO_COLOR=1` disables colour entirely; colour also switches off when stdout is
not a TTY.

## Statuses

| Status | Colour | Derived from |
|---|---|---|
| `asking` | yellow | an `AskUserQuestion` tool call, or a fresh permission denial |
| `interrupted` | yellow | `[Request interrupted by user]` in the transcript |
| `running` | blue | `stop_reason: "tool_use"` — a tool is executing (action names it) |
| `thinking` | purple | the newest line is a user turn or a tool result |
| `done` | green | `stop_reason: "end_turn"` — the turn finished |
| `idle` | grey | nothing recent, or a "running" tool older than `idleAfterMs` |

Rows sort by how much they want from you: `asking` first, `idle` last.

## Where the title comes from

Priority chain, in order:

1. **A name you gave the session** — read from the ccboard dashboard database
   (`~/.claude/agent-dashboard/dashboard.db`, table `sessions`, column `name`).
   Renaming a session is invisible to Claude Code's own files, which is why
   tools that read only `~/.claude/sessions` keep showing a stale title.
2. **`ai-title`** — the generated title inside the transcript.
3. **The first non-meta user message** — IDE notifications, slash-command output
   and `<tag>`-wrapped turns are skipped.
4. **`firstPrompt`** from a state file, if a hook ever wrote one.
5. **Project name + short session id.**

The footer tells you which source each visible row used, so a wrong title is
traceable. Two sessions that end up with the same title get their short id
appended instead of looking like duplicates.

## Configuration

`~/.claude/monitor/config.json`, created with defaults on first run and
**hot-reloaded**: edit it while the monitor runs and the next frame picks it up.

```json
{
  "theme": "dark",
  "glyphs": "ascii",
  "columns": ["status", "title", "action", "model", "branch", "src", "session", "time"],
  "refreshMs": 2000,
  "window": "4h",
  "showEmpty": false,
  "group": true,
  "wide": false,
  "idleAfterMs": 120000,
  "notifications": false
}
```

Columns: `status`, `title`, `project`, `action`, `model`, `branch`, `src`,
`session`, `time`. On a narrow terminal, columns are dropped in a fixed order
(`branch`, `model`, `project`, `session`, `action`, `src`) rather than squeezing
the title; the footer says what it dropped.

### Themes

Built in: `dark`, `light`, `solarized`, `mono` (no colour). Drop your own as
`~/.claude/monitor/themes/<name>.json` and set `"theme": "<name>"`:

```json
{
  "running": "#7aa2f7", "thinking": "#bb9af7", "done": "#9ece6a",
  "asking": "#e0af68", "interrupted": "#e0af68", "idle": "#565f89",
  "header": "#c0caf5", "dim": "#565f89", "accent": "#e0af68", "border": "#3b4261"
}
```

Missing keys fall back to `dark`, so a partial theme still renders.

## What it reads

| Path | Use | Mode |
|---|---|---|
| `~/.claude/sessions/<PID>.json` | which sessions exist (pid, id, cwd, entrypoint) | read only |
| `~/.claude/projects/<enc>/<id>.jsonl` | title, status, model, branch, queue depth | read only, windowed |
| `~/.claude/agent-dashboard/dashboard.db` | the name you gave a session | read only, optional |
| `~/.claude/monitor/config.json` | configuration | read + created once |
| `~/.claude/monitor/state/<id>.json` | optional hook state | read + written by the hook |
| `~/.claude/claude-monitor-status/*.json` | legacy state from an older install | read only |

Transcripts are never loaded whole: 128 KB from the head for the title, 64 KB
from the tail for the status, cached per file mtime. Measured on 33 live
sessions: 91 ms cold, 6–9 ms warm.

## Differences from upstream

- Rows are keyed by **session**, not by project directory. Upstream wrote
  `~/.claude/sessions/<project>.json`, so every chat in one workspace overwrote
  the same file — one row for N chats, and the same session duplicated across
  the directories it had `cd`'d into.
- Nothing is written into `~/.claude/sessions/`, which is Claude Code's own
  registry.
- Titles and statuses come from the transcript; `decodeDirName()` is gone (it
  turned `e-commerce` into `e\commerce`), replaced by encoding the real `cwd`.
- No `powershell.exe` spawn every 2 seconds: liveness is `process.kill(pid, 0)`.
- Themes, a config file with hot reload, responsive columns, flicker-free
  redraw, fixture tests.

`docs/DATA-SOURCES.md` records what was measured about each file format —
Claude Code can change them, and this file is the evidence the code rests on.

## Notes

- Windows-first by design; platform-specific code is confined to
  `lib/platform/win32.js`.
- The ccboard database is read with `node:sqlite` (Node 22.5+). Without it, that
  title source just goes quiet.
- Upstream has no LICENSE file. This is a personal fork; if you plan to publish,
  ask the original author about licensing first.
