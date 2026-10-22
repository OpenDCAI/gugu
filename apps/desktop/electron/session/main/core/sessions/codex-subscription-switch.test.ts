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
  selectHarnessConnection: vi.fn(async (_provider: string, connectionId: string) => {
    mocks.calls.push(`select:${connectionId}`);
  }),
}));
vi.mock('./session-orchestration', () => ({
  stopExactSessionpageSession: vi.fn(async (target: { sessionId: string }) => {
    mocks.calls.push(`stop:${target.sessionId}`);
    return true;
  }),
}));

const { switchCodexSubscription } = await import('./codex-subscription-switch');

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
  await switchCodexSubscription('work', {});
  expect(mocks.calls).toEqual(['stop:a', 'stop:b', 'select:work', 'reclaimed:a', 'reclaimed:b']);
});

it('refuses while a Codex session is mid-turn and touches nothing', async () => {
  summary('idle');
  summary('busy', { isGenerating: true });
  await expect(switchCodexSubscription('work', {})).rejects.toThrow('1 Codex session is still working');
  expect(mocks.calls).toEqual([]);
});

it('still hands stopped sessions back when the credential switch fails', async () => {
  summary('a');
  const { selectHarnessConnection } = await import('@main/core/agents/harness-connections');
  vi.mocked(selectHarnessConnection).mockRejectedValueOnce(new Error('keyring'));
  await expect(switchCodexSubscription('work', {})).rejects.toThrow('keyring');
  expect(mocks.calls).toEqual(['stop:a', 'reclaimed:a']);
});
