// Fabricated sessions for `--demo`.
//
// The README screenshots are generated from THIS, never from a live machine —
// a real screenshot would publish someone's session titles, project names and
// spend. Everything below is invented, and it is arranged to show each thing the
// board can tell you:
//
//   * one session waiting on you, one interrupted (both amber/red)
//   * two sessions on the SAME project, so the focus colour and glyph repeat
//   * a context that is nearly full next to one that is nearly empty
//   * a title too long for its column, so the wrap is visible
//   * a queued message and a plan in progress
//   * a session with sub-agents at work, and a finished-looking session whose
//     workflow is still running — the case the agent tree exists for

const MINUTE = 60000;

// The same shape lib/subagents.js returns, built by hand.
// `overflow` stands for plain agents cut by maxLines.
function tree(items, overflow) {
  const all = items.flatMap((it) => (it.kind === 'workflow' ? it.node.agents : [it.node]));
  const open = (st) => st === 'running' || st === 'thinking' || st === 'asking';
  const workflows = items.filter((it) => it.kind === 'workflow').map((it) => it.node);
  const shaped = items.map((it) => ({ ...it, open: open(it.kind === 'workflow' ? it.node.state : it.node.status) }));
  return {
    agents: items.filter((it) => it.kind === 'agent').map((it) => it.node),
    workflows,
    items: shaped,
    counts: {
      running: all.filter((a) => open(a.status)).length,
      total: items.reduce((n, it) => n + (it.kind === 'workflow' ? it.node.total : 1), 0) + (overflow || 0),
      workflows: workflows.filter((w) => open(w.state)).length,
    },
    overflow: overflow || 0,
    hidden: { workflows: 0, agents: overflow || 0 },
  };
}

const agent = (label, status, action, model, at, extra) => ({
  kind: 'agent',
  node: { id: label, label, type: 'general-purpose', model, status, action, startedMs: at, lastEventMs: at, ...(extra || {}) },
});

function demoRows(now) {
  const t = (mins) => now - mins * MINUTE;

  const cacheWork = tree([
    agent('Profile the cold start path', 'running', 'Bash', 'sonnet', t(0.03)),
    agent('Compare cache libraries', 'thinking', '', 'sonnet', t(0.1)),
    agent('Read the warmup config', 'done', '', 'haiku', t(3)),
  ], 1);

  const wfAgent = (label, status, action, at) => ({
    id: label, label, phase: 'Task 2', status, action, model: 'sonnet', lastEventMs: at,
  });
  const releaseRun = tree([{
    kind: 'workflow',
    node: {
      runId: 'wf_0a1b2c3d-4e5', name: 'release-checklist', status: 'running', state: 'running',
      phase: 'Task 2', done: 3, total: 4, running: 1, startedMs: t(40), lastEventMs: t(0.05), cost: 2.36,
      agents: [
        wfAgent('review-1', 'done', '', t(19)),
        wfAgent('fix-1-r1', 'done', '', t(9)),
        wfAgent('impl-2', 'running', 'Edit', t(0.05)),
      ],
    },
  }]);

  return [
    {
      sessionId: 'a1b2c3d4-1111-4aaa-8bbb-000000000001',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Invoice rounding is off by one cent',
      titleSource: 'user', status: 'asking', statusSource: 'ask-tool',
      action: 'AskUserQuestion', model: 'opus-5', branch: 'fix/rounding',
      effort: 'high', permissionMode: 'default', contextTokens: 42000,
      queued: 0, cost: 0.41, tokens: 1_240_000,
      agents: { running: 0, total: 2 },
      plan: { total: 3, completed: 2, inProgress: 1, pending: 0, current: 'Confirming the tax rule' },
      focus: { name: 'billing-api', score: 180, runnerUp: 22, confident: true },
      src: 'vsc', lastEvent: t(0.05), empty: false, pid: 4101,
    },
    {
      sessionId: 'b2c3d4e5-2222-4aaa-8bbb-000000000002',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Stop the nightly reconciliation job from double-charging retries',
      titleSource: 'ai-title', status: 'interrupted', statusSource: 'interrupt-marker',
      action: '', model: 'opus-5', branch: 'main',
      effort: 'high', permissionMode: 'default', contextTokens: 186000,
      queued: 1, cost: 3.02, tokens: 8_900_000,
      agents: { running: 0, total: 0 }, plan: null,
      focus: { name: 'billing-api', score: 240, runnerUp: 15, confident: true },
      src: 'cli', lastEvent: t(2), empty: false, pid: 4102,
    },
    {
      sessionId: 'c3d4e5f6-3333-4aaa-8bbb-000000000003',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Cache warmup takes 40s on cold start',
      titleSource: 'ai-title', status: 'running', statusSource: 'stop_reason',
      action: 'Bash', model: 'opus-5', branch: 'perf/warmup',
      effort: 'high', permissionMode: 'acceptEdits', contextTokens: 96000,
      queued: 0, cost: 1.18, tokens: 3_100_000,
      agents: { running: 2, total: 4 }, tree: cacheWork,
      plan: { total: 7, completed: 3, inProgress: 1, pending: 3, current: 'Profiling the cold path', list: [
        { id: '1', subject: 'Reproduce the 40s cold start', status: 'completed', blockedBy: [] },
        { id: '2', subject: 'Capture a flame graph', status: 'completed', blockedBy: [] },
        { id: '3', subject: 'List what warmup loads', status: 'completed', blockedBy: [] },
        { id: '4', subject: 'Profile the cold path', activeForm: 'Profiling the cold path', status: 'in_progress', blockedBy: [] },
        { id: '5', subject: 'Lazy-load the synonym index', status: 'pending', blockedBy: ['4'] },
        { id: '6', subject: 'Benchmark before and after', status: 'pending', blockedBy: ['5'] },
        { id: '7', subject: 'Write up the change', status: 'pending', blockedBy: ['6'] },
      ] },
      focus: { name: 'search-service', score: 300, runnerUp: 40, confident: true },
      src: 'vsc', lastEvent: t(0.02), empty: false, pid: 4103,
    },
    {
      sessionId: 'd4e5f6a7-4444-4aaa-8bbb-000000000004',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Rewrite the onboarding guide',
      titleSource: 'first-prompt', status: 'thinking', statusSource: 'tool_result',
      action: '', model: 'sonnet-5', branch: 'docs/onboarding',
      effort: 'medium', permissionMode: 'plan', contextTokens: 21000,
      queued: 0, cost: 0.09, tokens: 410_000,
      agents: null, plan: null,
      focus: { name: 'docs-site', score: 96, runnerUp: 30, confident: true },
      src: 'vsc', lastEvent: t(0.1), empty: false, pid: 4104,
    },
    {
      sessionId: 'e5f6a7b8-5555-4aaa-8bbb-000000000005',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Migrate the auth tables',
      titleSource: 'user', status: 'done', statusSource: 'stop_reason',
      action: '', model: 'opus-5', branch: 'main',
      effort: 'high', permissionMode: 'default', contextTokens: 174000,
      queued: 0, cost: 11.74, tokens: 26_400_000,
      agents: { running: 1, total: 4 }, tree: releaseRun,
      plan: { total: 9, completed: 9, inProgress: 0, pending: 0, current: '' },
      focus: { name: 'auth-service', score: 410, runnerUp: 18, confident: true },
      src: 'vsc', lastEvent: t(34), empty: false, pid: 4105,
    },
    {
      sessionId: 'f6a7b8c9-6666-4aaa-8bbb-000000000006',
      project: 'workspace', cwd: 'C:\\Users\\you\\workspace',
      title: 'Look into the flaky snapshot test',
      titleSource: 'ai-title', status: 'idle', statusSource: 'stop_reason+stalled',
      action: '', model: 'sonnet-5', branch: 'main',
      effort: 'medium', permissionMode: 'default', contextTokens: 8000,
      queued: 0, cost: 0.02, tokens: 120_000,
      agents: null, plan: null,
      focus: null,
      src: 'cli', lastEvent: t(96), empty: false, pid: 4106,
    },
  ];
}

// What each fabricated session last heard, said and did (lib/recent.js shape).
const RECENT = {
  'Invoice rounding is off by one cent': {
    lastPrompt: 'the totals on invoice 2291 are a cent off, find out where the rounding happens',
    reply: 'The cent is lost in `applyTax()`: it rounds each line before summing. Should I round once on the total instead, or keep per-line rounding and add a correction line?',
    activity: [['AskUserQuestion', 'Round once on the total?', 0.05], ['Read', 'tax.ts', 2], ['Grep', 'Math.round', 3], ['Bash', 'Run the invoice tests', 6]],
  },
  'Cache warmup takes 40s on cold start': {
    lastPrompt: 'cold start is 40 seconds again, profile it and tell me what loads',
    reply: 'The synonym index (2.1 GB) is loaded eagerly during warmup; that is 31 of the 40 seconds. Profiling the rest now.',
    activity: [['Bash', 'Profile the cold start', 0.03], ['Agent', 'Compare cache libraries', 0.1], ['Read', 'warmup.config.json', 3], ['Edit', 'loader.ts', 9]],
  },
  'Migrate the auth tables': {
    lastPrompt: 'run the release checklist workflow when the migration is in',
    reply: 'Migration applied on staging, all 9 tasks done. The release-checklist workflow is still running its last review.',
    activity: [['Workflow', 'workflow script', 40], ['Bash', 'Apply the migration on staging', 52]],
  },
};

function withRecent(rows, now) {
  for (const r of rows) {
    const x = RECENT[r.title];
    if (!x) continue;
    r.recent = { lastPrompt: x.lastPrompt, reply: x.reply, replyAt: now - 60000,
      activity: x.activity.map(([name, detail, mins]) => ({ name, detail, at: now - mins * MINUTE })) };
  }
  return rows;
}

function closed(now) {
  const t = (mins) => (now || Date.now()) - mins * MINUTE;
  return [
    { sessionId: 'a7b8c9d0-7777-4aaa-8bbb-000000000007', title: 'Draft the Q3 pricing memo', lastEvent: t(75), startedAt: t(190),
      cwd: 'C:\\Users\\you\\workspace', lastPrompt: 'shorten the second section', reply: 'Done: the second section is now four sentences.' },
    { sessionId: 'b8c9d0e1-8888-4aaa-8bbb-000000000008', title: 'Rename the metrics package', lastEvent: t(26 * 60), startedAt: t(27 * 60),
      cwd: 'C:\\Users\\you\\workspace', lastPrompt: 'also update the imports in the tests', reply: 'All 41 imports updated; tests pass.' },
  ];
}

function snapshot(now) {
  const n = now || Date.now();
  return { rows: withRecent(demoRows(n), n), hiddenEmpty: 2, hiddenStale: 1 };
}

// A fabricated day for the web page's timeline.
function timeline(now) {
  const t = (mins) => (now || Date.now()) - mins * MINUTE;
  const ev = (mins, type, title, focus, extra) => ({ at: t(mins), type, title, focus, sessionId: '', ...extra });
  return [
    ev(212, 'session', 'Look into the flaky snapshot test', '', { status: 'done' }),
    ev(150, 'workflow', 'Migrate the auth tables', 'auth-service', { name: 'schema-review', status: 'done', total: 5, durationMs: 23 * MINUTE, cost: 4.12 }),
    ev(96, 'task', 'Migrate the auth tables', 'auth-service', { name: 'Backfill the session column' }),
    ev(61, 'agent', 'Cache warmup takes 40s on cold start', 'search-service', { name: 'Read the warmup config', status: 'done' }),
    ev(34, 'session', 'Migrate the auth tables', 'auth-service', { status: 'done' }),
    ev(18, 'task', 'Cache warmup takes 40s on cold start', 'search-service', { name: 'List what warmup loads' }),
    ev(2, 'session', 'Stop the nightly reconciliation job from double-charging retries', 'billing-api', { status: 'interrupted' }),
    ev(0.05, 'session', 'Invoice rounding is off by one cent', 'billing-api', { status: 'asking', action: 'AskUserQuestion' }),
  ];
}

module.exports = { snapshot, demoRows, timeline, closed };
