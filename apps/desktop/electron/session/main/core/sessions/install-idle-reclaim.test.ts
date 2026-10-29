import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdleReclaimDeps } from './idle-reclaim';

const state = vi.hoisted(() => ({
  deps: null as IdleReclaimDeps | null,
  ptys: [] as Array<{ ptySessionId: string; metadata?: { providerId: string } }>,
  tmux: new Set<string>(),
  listTmux: vi.fn(),
  rows: new Map<string, { projectId: string; archivedAt?: string }>(),
  closeBrowser: vi.fn(),
}));

vi.mock('./idle-reclaim', async (original) => {
  const actual = await original<typeof import('./idle-reclaim')>();
  return { ...actual, IdleReclaimer: class extends actual.IdleReclaimer {
    constructor(deps: IdleReclaimDeps) { super(deps); state.deps = deps; }
  } };
});
vi.mock('@main/core/acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: () => new Map() } }));
vi.mock('@main/core/extensions/extension-bridge', () => ({ currentOrLastSession: () => null }));
vi.mock('@main/core/execution-context/local-execution-context', () => ({ LocalExecutionContext: class {} }));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => state.ptys } }));
vi.mock('@main/core/pty/tmux-session-name', async (original) => ({
  ...await original<typeof import('@main/core/pty/tmux-session-name')>(),
  getConfiguredTmuxSocketLabel: () => 'test-owned-tmux',
  listTmuxSessionNames: () => state.listTmux(),
}));
vi.mock('@main/core/session-timeline/remote-pane', () => ({ sharedRemotePaneRoute: () => ({ watching: () => false }) }));
vi.mock('drizzle-orm', () => ({ eq: (_column: unknown, id: string) => id }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id' } }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: (id: string) => ({ get: () => state.rows.get(id) }) }) }),
} }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./session-orchestration', () => ({ stopExactSessionpageSession: vi.fn(async () => true) }));
vi.mock('./sessions-on-screen', () => ({ sessionOnScreen: () => false }));
vi.mock('./tui-resume-exactness', () => ({ tuiResumesExactly: () => true }));
vi.mock('./utils', () => ({ mapSessionRowToSession: (row: unknown) => row }));
vi.mock('../../../../browser-agent-mcp', () => ({ closeSessionBrowserTools: (...args: unknown[]) => state.closeBrowser(...args) }));

import { makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { installIdleReclaim } from './install-idle-reclaim';
import { stopExactSessionpageSession } from './session-orchestration';

describe('idle reclaim resource enumeration', () => {
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    state.ptys = [];
    state.tmux = new Set();
    state.listTmux.mockReset().mockImplementation(async () => state.tmux);
    state.rows.clear();
    state.closeBrowser.mockReset();
    dispose = installIdleReclaim({ agentStatus: { on: vi.fn() } });
  });
  afterEach(() => dispose?.());

  it('finds an agent surviving in tmux without a PTY attached to this host', async () => {
    state.tmux.add(makeTmuxSessionName('p:cold:cold'));
    state.tmux.add('unrelated-user-session');
    expect(await state.deps!.listLive()).toEqual([{ projectId: 'p', sessionId: 'cold', runtime: 'pty' }]);
  });

  it('deduplicates attached agents and protects detached user terminal shells', async () => {
    state.ptys = [{ ptySessionId: 'p:agent:agent', metadata: { providerId: 'codex' } }];
    state.tmux.add(makeTmuxSessionName('p:agent:agent'));
    state.tmux.add(makeTmuxSessionName('p:agent:terminal'));
    expect(await state.deps!.listLive()).toEqual([{ projectId: 'p', sessionId: 'agent', runtime: 'pty' }]);
    expect(state.deps!.sessionsWithLiveTerminals()).toEqual(new Set(['agent']));
  });

  it('rechecks native idleness before stopping and closes its local browser tools', async () => {
    const target = { projectId: 'p', sessionId: 'idle' };
    vi.mocked(stopExactSessionpageSession).mockClear();
    await state.deps!.stop(target, 'acp');
    expect(stopExactSessionpageSession).toHaveBeenCalledWith({ ...target, onlyIfIdle: true });
    expect(state.closeBrowser).toHaveBeenCalledWith('idle');
  });

  it('does not turn a failed tmux read into a false empty-process reading', async () => {
    state.listTmux.mockRejectedValue(new Error('tmux unreadable'));
    await expect(state.deps!.listLive()).rejects.toThrow('tmux unreadable');
  });

});
