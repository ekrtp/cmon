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

const MINUTE = 60000;

function demoRows(now) {
  const t = (mins) => now - mins * MINUTE;

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
      agents: { running: 2, total: 4 },
      plan: { total: 7, completed: 3, inProgress: 1, pending: 3, current: 'Profiling the cold path' },
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
      agents: { running: 0, total: 6 },
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

function snapshot(now) {
  return { rows: demoRows(now || Date.now()), hiddenEmpty: 2, hiddenStale: 1 };
}

module.exports = { snapshot, demoRows };
