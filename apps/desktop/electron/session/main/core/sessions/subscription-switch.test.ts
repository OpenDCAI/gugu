import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  summaries: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
}));

vi.mock('@main/core/acp/agent-status-bridge', () => ({
  acpAgentStatusBridge: { current: () => mocks.summaries },
}));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => [] } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/lib/events', () => ({
  events: { emit: (_channel: unknown, target: { sessionId: string }) => mocks.calls.push(`reclaimed:${target.sessionId}`) },
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
