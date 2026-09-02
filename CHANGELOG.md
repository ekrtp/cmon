# Changelog — cmon

This fork's history, newest first. Upstream
([ibrahimokdadov/claudeMonitor](https://github.com/ibrahimokdadov/claudeMonitor))
is the two commits at the bottom.

## 1.0.1

- **Fixed: renaming a session in the IDE did not change the title.** The rename
  is written into the transcript as a `custom-title` line, which the title chain
  never looked at. It read a *curated name* out of the ccboard dashboard
  database instead — and that database had not been written to in five days, so
  it served the pre-rename name for the one session it still knew about and
  nothing at all for the nine started since. Renames were invisible either way.
  - `custom-title` is now the top of the chain, and a curated board name sits
    below it: the transcript is written by the tool you are typing in, the
    database by a process that may not be running.
  - A rename **appends** a record rather than rewriting the old ones (measured:
    197 copies, 2 distinct values, in one file), so the **newest** copy wins.
    Same for `ai-title`, which drifts too and is no longer cached forever.
  - Both records are read from a **64 KB tail** (measured: a re-emitted copy
    lands ≤30 KB from EOF; the first copy can be 11,981 KB from the start, which
    no head window reaches) and from the 128 KB head as well, because 9
    transcripts of 91 wrote the record once and never re-emitted it. Together
    the two windows return the name the file ends on in **91 of 91** cases.
  - `node scripts/probe-titles.js` reproduces every number above, including that
    91-of-91 acceptance check.
  - Measured over 10 live sessions: 68–81 ms cold, 11–16 ms warm, against
    64–117 / 10–22 ms for the chain it replaces. Rows showing a name a person
    typed: **1 → 5**, and the 1 was stale.

## 1.0.0 — published

- Renamed to **cmon**, which is what the command has been all along.
- README says why this exists, credits upstream, and quantifies what changed
  since the fork point (+4,533 / −244 lines; 29 of 36 files are new).
- Licensing spelled out: upstream ships no LICENSE, so this stays a GitHub fork
  rather than a detached project.

## 0.8.0

- **Fixed: the theme changed by itself.** The test suite wrote a theme into the
  real `~/.claude/monitor/config.json`, and every running board picked it up
  because the file is watched. `lib/config.js` now honours
  `CLAUDE_MONITOR_CONFIG`, and the suite points it at a temp directory.
- `g` cycles the grouping (`status` → `focus` → `project` → `none`) and keeps the
  choice.
- **Zebra striping.** Alternate rows carry a faint band mixed from the theme's
  own background and text colour, covering *every* line of a row — which is what
  makes a wrapped two-line row read as one session. `zebra`, `zebraStrength`.

## 0.7.0

- **Focus identity.** Each project name gets a colour and a glyph derived from
  the name itself (FNV-1a), so two rows on the same project look alike at a
  glance; the glyph keeps the distinction when colour is off.
- `focus` wraps onto a second line like `title`, breaking on hyphens and
  underscores as well as spaces.
- README rebuilt with generated SVG screenshots (`scripts/screenshot.js`) drawn
  from fabricated sessions (`lib/demo.js`) — never from a real machine.

## 0.6.0

- Titles wrap instead of being cut off (`titleLines`).
- The `ctx` cell is coloured on a continuous green→amber→red ramp built from the
  active theme, so the chat that needs compacting is obvious.
- `--themes` previews every theme in colour instead of listing names.
- Text measurement, clipping and wrapping moved into `lib/text.js`.

## 0.5.0

- Back to watching only: keyboard navigation removed.
- Themes 4 → 17, including `cswap` / `cswap-light` adapted from claude-swap's own
  TUI palette.
- Status glyphs animate (spinner for the live states, a slow pulse for `asking`)
  on a separate clock that repaints the last snapshot without touching disk.
- Rows group by status by default, with human headings.
- **`focus`**: which project a session is actually about, scored from the
  transcript against the workspace's `CLAUDE.md` project list.

## 0.4.0

- Cost and token totals per session, sub-agent counts (dashboard database).
- Context occupancy, plan progress from `~/.claude/tasks`, queue depth.
- Desktop notification on the transition into `asking` / `interrupted`.
- `scripts/config.js`, `scripts/install-hooks.js`, `scripts/uninstall-hooks.js`,
  `scripts/install-command.js` (the `cmon` command).

## 0.3.0

- Theme system with a config file that hot-reloads.
- **Status is derived from the transcript**, not from hook state files: the old
  source was keyed by project, so every chat in a workspace overwrote the others.
- Titles read a curated session name when one exists.
- The application (code, comments, interface, README) is in English.

## 0.2.0

- **One row per session.** Rows come from Claude Code's own registry instead of
  project-keyed state files, which had been collapsing N chats into one row and
  duplicating a single session across every directory it had visited.
- Titles resolve from the transcript's `ai-title`, falling back to the first
  non-meta prompt.
- Liveness via `process.kill(pid, 0)` — no `powershell.exe` spawn every 2s.
- Fixture test suite.

## 0.1.0

- Fork point. State moved out of `~/.claude/sessions/` (Claude Code's own
  registry) into a directory of our own.
