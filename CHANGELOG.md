# Changelog — cmon

This fork's history, newest first. Upstream
([ibrahimokdadov/claudeMonitor](https://github.com/ibrahimokdadov/claudeMonitor))
is the two commits at the bottom.

## 1.2.1

- **The agent tree shows everything.** No 8-line cap per session, no
  `+N more agents` / `+1 more workflow` line, no shrinking the tree to the
  terminal height, and a workflow lists all of its agents instead of the open
  ones plus the two that finished last. The linger window (`agentLingerMs`) is
  the only filter left. `agentLines` is gone from the config; an old value is
  ignored.
- A frame taller than the terminal now clears the screen and scrollback before
  each repaint, so it scrolls cleanly instead of stacking copies of its top.

## 1.2.0

- **`cmon --web`: the board as a local page** (`lib/web.js`, `web/index.html`).
  Three lanes (waiting on you · working · finished), cards with context bar,
  cost, workflow progress bars and plan progress; click for the full task list,
  every sub-agent and workflow agent, and the session id. 127.0.0.1 only, no
  network, Server-Sent Events pushed only on change, nothing drawn while hidden.
- **Today timeline** (`lib/timeline.js`): sessions, workflows (agents, duration,
  cost), tasks and sub-agents as they finish, kept per day under
  `~/.claude/monitor/timeline/`.
- **Cost from the transcripts** (`lib/cost.js`, `lib/prices.js`). It used to come
  from dashboard.db, which stopped updating on 2026-08-28 and had no Opus 5 row:
  measured, every one of 13 live sessions came back with no cost at all. Now
  every `usage` block is summed once per `message.id`, sub-agents and workflow
  agents included, read incrementally (first pass over 13 sessions ~6 s, then
  ~30 ms).
- `lib/tasks.js` returns the task list itself, not only the counts.
- **What it said and did** (`lib/recent.js`): last prompt, last reply and the last
  eight tool calls per session, from the transcript tail.
- **Closed recently**: transcripts touched in the last 3 days with no live
  session, with a resume line to copy. Plugin runs of `claude -p` from folders
  under `~/.claude` (measured: 22 of 27 "closed" sessions) are left out.
- Background work moves a card to Working; quiet open tabs become one-line rows;
  the timeline folds a session's turns within half an hour into one line; a theme
  menu on the page.

## 1.1.0

- **Sub-agents and workflow runs, as a tree under each session.** `/workflows`
  only works in the terminal that started the run, so from the IDE extension
  there was no way to see which workflow agent was doing what. Everything
  needed is already on disk next to the transcript (`lib/subagents.js`):
  - `subagents/agent-<id>.jsonl` + `.meta.json` for Agent-tool sub-agents,
    `subagents/workflows/<runId>/journal.jsonl` plus one transcript per agent
    for a workflow run, and — searched across every project directory, because
    a session's cwd can move — `workflows/scripts/<name>-<runId>.js` (the run's
    name while it runs) and `workflows/<runId>.json` (written when it ends).
  - Each child gets its own status from its own transcript, with the session
    rules and the same stall rule. `status.derive()` takes `{ sidechain: true }`
    for this: every line of a sub-agent transcript is `isSidechain`, which the
    session derivation skips by design.
  - Sub-agents stall on their own threshold, `agentIdleAfterMs` (15 min), not
    the session's 2 min: measured, a working sub-agent can sit silent for 745 s
    inside one Bash call. A plain sub-agent whose last line is a text block with
    no `stop_reason` (it happens: once in 164) settles as `done`, not `idle`.
  - A workflow line shows its name, newest phase and `done/total`; inside it,
    every open or stuck agent plus the two that finished last. `done` counts
    result lines only — a quiet agent is not done — and a retried agent (same
    journal key, new agentId, measured on resumed runs) counts once: a run of 6
    had read 11/11. On a narrow terminal the name is cut, never `done/total`,
    and every cut shows an ellipsis.
  - Finished nodes stay for `agentLingerMs` (10 min); at most `agentLines` (8)
    lines per session, the rest summed as `+N more agents` or
    `+1 more workflow, 3 agents` — nodes, not lines.
  - The frame never grows taller than the terminal: the trees shrink to fit, so
    a short IDE terminal panel does not scroll on every repaint.
  - A session that reads `done` while its workflow runs on (also between two
    agents, when none is open) says `wf running` in its ACTION cell, or
    `done +wf` in STATUS when a narrow terminal has dropped ACTION.
  - `a` toggles the tree and keeps the choice, `--no-agents` hides it for a run,
    `showAgents` in the config. The AGENTS column counts from the same files.
  - Cost, measured over 8 live sessions carrying 95 sub-agents: 125 ms on the
    first frame, 5–7 ms per refresh after it. Every file is cached on
    (mtime, size), a finished agent is cached for good, a journal is read
    incrementally, and its result lines (up to 35 KB) are never parsed. One
    tool result can outgrow the 32 KB tail (measured: 316 KB lines, in 6 of 148
    agent transcripts), so that window widens only when it holds no whole line.
    An unchanged journal is not read at all, even one ending in a cut-off line,
    and cache entries unused for 10 minutes are swept.
- `status.derive()`: a tool result carrying `toolEndsTurn: true` ends the turn
  (`done`) — how a workflow agent finishes, on its `StructuredOutput` call.
- **Fixed: lines wider than the terminal.** Whatever followed the last column
  (`+1 queued`, the plan step) and the footer on a narrow screen ran past the
  edge and wrapped, shearing the table. Every line is now clipped to the width,
  and an extra is shown only when it fits whole.
- README screenshots regenerated from `--demo`, which now has sub-agents and a
  running workflow (`release-checklist`). The social-preview PNG is unchanged:
  it needs a browser render.

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
