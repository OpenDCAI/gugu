import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  summaries: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
  progress: [] as string[],
}));

vi.mock('@main/core/acp/agent-status-bridge', () => ({
  acpAgentStatusBridge: { current: () => mocks.summaries },
}));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => [] } }));
// session-life says which sessions run (here: every summarized one); the row says its project and provider.
vi.mock('./session-life', () => ({ sessionLife: () => ({ running: () => [...mocks.summaries.keys()] }) }));
vi.mock('drizzle-orm', () => ({ eq: (_column: unknown, id: string) => id }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id' } }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: (id: string) => ({ get: () => {
    const found = mocks.summaries.get(id);
    return found && { projectId: found.projectId, provider: found.providerId };
  } }) }) }),
} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/lib/events', () => ({
  events: {
    emit: (channel: { name: string }, data: { sessionId?: string; closed?: number; total?: number }) => {
      if (channel.name === 'subscriptions:switch-progress') mocks.progress.push(`${data.closed}/${data.total}`);
      else mocks.calls.push(`reclaimed:${data.sessionId}`);
    },
  },
}));
vi.mock('@main/core/agents/harness-connections', () => ({
  assertHarnessConnectionSelectable: vi.fn(async () => undefined),
  selectHarnessConnection: vi.fn(async (provider: string, connectionId: string) => {
    mocks.calls.push(`select:${provider}:${connectionId}`);
  }),
}));
vi.mock('./session-orchestration', () => ({
  stopExactSessionpageSession: vi.fn(async (target: { sessionId: string }) => {
    mocks.calls.push(`stop:${target.sessionId}`);
    return true;
  }),
}));

const { switchSubscription } = await import('./subscription-switch');
const { SubscriptionSessionsBusyError, connectionFailure } = await import('./subscription-sessions-busy');

function summary(sessionId: string, overrides: Record<string, unknown> = {}) {
  mocks.summaries.set(sessionId, {
    sessionId,
    projectId: 'project',
    providerId: 'codex',
    lifecycle: 'ready',
    isGenerating: false,
    pendingPermissionCount: 0,
    queuedPromptCount: 0,
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    ...overrides,
  });
}

beforeEach(() => {
  mocks.summaries.clear();
  mocks.calls.length = 0;
  mocks.progress.length = 0;
});

it('stops idle Codex sessions before the credentials change and hands them back afterwards', async () => {
  summary('a');
  summary('b');
  summary('claude', { providerId: 'claude' });
  await switchSubscription('codex', 'work', {});
  expect(mocks.calls).toEqual(['stop:a', 'stop:b', 'select:codex:work', 'reclaimed:a', 'reclaimed:b']);
});

it('does the same for Claude and leaves the other provider’s sessions running', async () => {
  summary('a', { providerId: 'claude' });
  summary('codex');
  await switchSubscription('claude', 'work', {});
  expect(mocks.calls).toEqual(['stop:a', 'select:claude:work', 'reclaimed:a']);
});

it('refuses while a session of that provider is mid-turn and touches nothing', async () => {
  summary('idle');
  summary('busy', { isGenerating: true });
  await expect(switchSubscription('codex', 'work', {})).rejects.toThrow('1 Codex session is still working');
  summary('claude-busy', { providerId: 'claude', pendingPermissionCount: 1 });
  await expect(switchSubscription('claude', 'work', {})).rejects.toThrow('1 Claude session is still working');
  expect(mocks.calls).toEqual([]);
});

it('says which provider and how many sessions are working, so the UI can word it itself', async () => {
  summary('a', { isGenerating: true });
  summary('b', { queuedPromptCount: 2 });
  summary('idle');
  const refusal = await switchSubscription('codex', 'work', {}).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(SubscriptionSessionsBusyError);
  expect(refusal).toMatchObject({ providerId: 'codex', count: 2 });
  expect(connectionFailure(refusal)).toEqual({
    type: 'invalid-state',
    message: (refusal as Error).message,
    sessionsBusy: { providerId: 'codex', count: 2 },
  });
});

// 起到一半、回放中的也算在忙:正常几秒就起完;起不完是启动的毛病，靠「关掉并切换」出来,❌ 在这里假装它不忙。
it('counts sessions that are starting or replaying as working', async () => {
  summary('starting', { lifecycle: 'starting' });
  summary('replaying', { lifecycle: 'replaying' });
  summary('idle');
  await expect(switchSubscription('codex', 'work', {})).rejects.toMatchObject({ count: 2 });
  expect(mocks.calls).toEqual([]);
  await switchSubscription('codex', 'work', {}, { stopBusySessions: true });
  expect(mocks.calls).toEqual(['stop:starting', 'stop:replaying', 'stop:idle', 'select:codex:work', 'reclaimed:starting', 'reclaimed:replaying', 'reclaimed:idle']);
});

// 用户看过「有会话正在工作」仍要切(额度用完时手上的回合本来也跑不下去):正在工作的也一起关掉，照切。
it('closes working sessions too when the user chose to close them and switch', async () => {
  summary('busy', { isGenerating: true });
  summary('idle');
  await switchSubscription('codex', 'work', {}, { stopBusySessions: true });
  expect(mocks.calls).toEqual(['stop:busy', 'stop:idle', 'select:codex:work', 'reclaimed:busy', 'reclaimed:idle']);
  // 进度条读的是真关掉了几个:开始时 0/2,每关完一个推一次。
  expect(mocks.progress).toEqual(['0/2', '1/2', '2/2']);
});

it('reports no progress when there is nothing to close', async () => {
  await switchSubscription('codex', 'work', {});
  expect(mocks.calls).toEqual(['select:codex:work']);
  expect(mocks.progress).toEqual([]);
});

it('waits out a process that is still exiting instead of failing the switch', async () => {
  summary('slow', { isGenerating: true });
  const { stopExactSessionpageSession } = await import('./session-orchestration');
  vi.mocked(stopExactSessionpageSession).mockClear();
  const pending = () => Object.assign(new Error('stop_pending'), { code: 'stop_pending' });
  vi.mocked(stopExactSessionpageSession).mockRejectedValueOnce(pending()).mockRejectedValueOnce(pending());
  await switchSubscription('codex', 'work', {}, { stopBusySessions: true });
  expect(mocks.calls).toEqual(['stop:slow', 'select:codex:work', 'reclaimed:slow']);
  expect(vi.mocked(stopExactSessionpageSession)).toHaveBeenCalledTimes(3);
});

it('gives up and keeps the old subscription when a process never exits', async () => {
  summary('stuck');
  const { stopExactSessionpageSession } = await import('./session-orchestration');
  vi.mocked(stopExactSessionpageSession).mockClear();
  const pending = Object.assign(new Error('stop_pending'), { code: 'stop_pending' });
  vi.mocked(stopExactSessionpageSession).mockRejectedValueOnce(pending).mockRejectedValueOnce(pending).mockRejectedValueOnce(pending);
  await expect(switchSubscription('codex', 'work', {})).rejects.toThrow('stop_pending');
  expect(vi.mocked(stopExactSessionpageSession)).toHaveBeenCalledTimes(3);
  expect(mocks.calls).toEqual([]);
});

it('keeps every other connection failure a plain message', () => {
  expect(connectionFailure(new Error('login missing'))).toEqual({ type: 'invalid-state', message: 'login missing' });
  expect(connectionFailure('boom')).toEqual({ type: 'invalid-state', message: 'boom' });
});

it('still hands stopped sessions back when the credential switch fails', async () => {
  summary('a');
  const { selectHarnessConnection } = await import('@main/core/agents/harness-connections');
  vi.mocked(selectHarnessConnection).mockRejectedValueOnce(new Error('keyring'));
  await expect(switchSubscription('codex', 'work', {})).rejects.toThrow('keyring');
  expect(mocks.calls).toEqual(['stop:a', 'reclaimed:a']);
});

it('keeps running sessions alive when the target connection cannot be switched to', async () => {
  summary('a');
  const { assertHarnessConnectionSelectable } = await import('@main/core/agents/harness-connections');
  vi.mocked(assertHarnessConnectionSelectable).mockRejectedValueOnce(new Error('no saved sign-in'));
  await expect(switchSubscription('codex', 'work', {})).rejects.toThrow('no saved sign-in');
  expect(mocks.calls).toEqual([]);
});
