import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ files: new Map<string, string>(), emit: vi.fn(), fault: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const text = mocks.files.get(path);
    if (text === undefined) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
    return text;
  }),
  readdir: vi.fn(async (dir: string) => [...mocks.files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1))),
}));
vi.mock('../../../../server/process-alive', () => ({ isProcessAlive: () => true }));
vi.mock('./agent-hook-service', () => ({ agentHookService: { emitAgentEvent: mocks.emit } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: {
  isWorkingOrWaiting: () => true, reportStatusSourceFault: mocks.fault,
} }));
vi.mock('./harness-config-roots', () => ({ harnessConfigRootOf: () => undefined }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
const { claudePresenceFile } = await import('../../../../../../../packages/session-plugins/src/agents/impl/claude/presence');
const { startPresenceInterrupt, PRESENCE_POLL_MS } = await import('./presence-interrupt');
const plugin = {
  capabilities: { hooks: { kind: 'config' as const, scope: 'workspace' as const, supportedEvents: ['stop' as const], presence: { sinceVersion: '2.1.175' } } },
  behavior: { hooks: { presence: claudePresenceFile } },
};
const path = '/fixture/.claude/sessions/42.json';
const record = (status: string) => mocks.files.set(path, JSON.stringify({ pid: 42, sessionId: 'provider-id', status }));
describe('U6 presence watcher across a terminal reattach', () => {
  let stop: (() => void) | undefined;
  const start = (mode: 'fresh' | 'reattach', status: 'working' | 'needs_user', detail: 'running' | 'parked' | 'approval') => {
    const input = { plugin, harnessVersion: '2.1.301', spawnEnv: { HOME: '/fixture' },
      harnessSessionId: () => 'provider-id', sessionId: 'survivor', projectId: 'p1', providerId: 'claude',
      start: mode, reading: { status, detail } };
    stop = startPresenceInterrupt(input);
  };
  beforeEach(() => { vi.useFakeTimers(); mocks.files.clear(); mocks.emit.mockClear(); mocks.fault.mockClear(); });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
  it.each([['working', 'running'], ['needs_user', 'approval']] as const)('seeds a reattach from %s so its first idle read is one real interruption', async (status, detail) => {
    record('idle'); start('reattach', status, detail);
    await vi.advanceTimersByTimeAsync(2 * PRESENCE_POLL_MS);
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'stop', sessionId: 'survivor', payload: { outcome: 'cancelled' } }));
    expect(mocks.fault).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });
  it('keeps a fresh spawn idle to busy transition free of interruptions', async () => {
    record('idle'); start('fresh', 'working', 'running');
    await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
    record('busy'); await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('keeps a parked reattach shell to idle transition free of interruptions', async () => {
    record('idle'); start('reattach', 'working', 'parked');
    await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
