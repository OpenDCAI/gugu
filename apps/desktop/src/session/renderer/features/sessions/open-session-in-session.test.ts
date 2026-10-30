import { describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';

const opened = vi.hoisted(() => ({ calls: [] as unknown[], tabs: 0, views: [] as string[], provisioned: true, archived: false, provision: vi.fn(), reason: null as string | null, machineReason: null as string | null }));
const ready = observable.box(true);

vi.mock('@renderer/features/sessions/stores/session-selectors', () => {
  const paneLayout = {
    get groups() {
      return [{ pane: { tabOrder: Array.from({ length: opened.tabs }, (_, i) => `t${i}`) } }];
    },
    open: (...args: unknown[]) => opened.calls.push(args),
  };
  return {
    asProvisioned: (page: unknown) => page,
    getSessionPageStore: () => (opened.provisioned && ready.get() ? { viewModel: {} } : null),
    getSessionView: (projectId: string, sessionId: string) => {
      opened.views.push(`${projectId}/${sessionId}`);
      return { paneLayout };
    },
    getSessionManagerStore: () => ({ provisionSession: opened.provision }),
    sessionViewKind: () => opened.archived ? 'archived' : 'idle',
  };
});
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ mountProject: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: { get: () => ({ sessions: { get: () => ({ data: { runtime: 'pty' } }) } }) },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (k: string) => k }));

vi.mock('./workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => opened.reason }));
vi.mock('./machine-unavailable-label', () => ({ machineUnavailableLabel: () => opened.reason ?? opened.machineReason }));

import { toast } from '@renderer/lib/hooks/use-toast';
import { openSessionInSessionWhenReady } from './open-session-in-session';

describe('给屏上一块空着的会话补上对话(onlyIfNoTabs)', () => {
  it('一枚页签都没有:开它的对话', () => {
    opened.calls = [];
    opened.tabs = 0;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    expect(opened.calls).toHaveLength(1);
  });

  it('存下的页签已经摆回来了:不动,❌ 把停在别的页签上的那一枚抢成对话', () => {
    opened.calls = [];
    opened.tabs = 2;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    expect(opened.calls).toHaveLength(0);
  });

  it('opens the existing transcript for a search anchor without changing the task runtime', () => {
    opened.calls = [];
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', transcript: true });
    expect(opened.calls).toEqual([['acp-chat', { sessionId: 's' }, { preview: false }]]);
  });

  it('点左边一行(不带 onlyIfNoTabs):照旧打开对话', () => {
    opened.calls = [];
    opened.tabs = 2;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's' });
    expect(opened.calls).toHaveLength(1);
  });

  it('群聊第二个 Agent：页签在已有右栏打开，资源仍属于目标会话', () => {
    opened.calls = [];
    opened.views = [];
    openSessionInSessionWhenReady({ projectId: 'other-project', sessionId: 'agent-2', host: { projectId: 'p', sessionId: 'agent-1' } });
    expect(opened.calls).toEqual([['session', { sessionId: 'agent-2', projectId: 'other-project', ownerSessionId: 'agent-2' }, { preview: false }]]);
    expect(opened.views).toEqual(['p/agent-1', 'p/agent-1']);
  });
});

describe('task entry keeps the workspace failure reason', () => {
  it('names the offline machine when a cold project has no workspace status yet', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(toast).mockClear();
    opened.provisioned = false;
    opened.reason = null;
    opened.machineReason = 'mac1 is offline. Resumes when it is back';
    const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's' });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: opened.machineReason,
      }));
    } finally {
      dispose();
      opened.provisioned = true;
      opened.machineReason = null;
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ['cloud', 'Gugu on cloud host is too old. Update Gugu there'],
    ['ssh', 'Gugu on SSH host is too old. Update Gugu there'],
    ['local', null],
  ])('%s entry uses the current reason when readiness times out', async (_route, reason) => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(toast).mockClear();
    opened.provisioned = false;
    opened.reason = null;
    const onReady = vi.fn();
    const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
    try {
      // The handshake can discover the mismatch after navigation starts.
      opened.reason = reason;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onReady).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: reason ?? 'sidebar.workspaceNotReady',
      }));
    } finally {
      dispose();
      opened.provisioned = true;
      opened.reason = null;
      logged.mockRestore();
      vi.useRealTimers();
    }
  });
});

it('commits the screen layout only after the workspace and conversation are ready', () => {
  ready.set(false);
  opened.calls = [];
  const onReady = vi.fn(() => expect(opened.calls).toHaveLength(1));
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    expect(onReady).not.toHaveBeenCalled();
    expect(opened.calls).toHaveLength(0);
    runInAction(() => ready.set(true));
    expect(onReady).toHaveBeenCalledOnce();
  } finally {
    dispose();
    runInAction(() => ready.set(true));
  }
});

it('prepares an idle background task through the existing workspace preparation path', async () => {
  ready.set(false);
  opened.provision.mockImplementationOnce(async () => { runInAction(() => ready.set(true)); });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    expect(onReady).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(opened.provision).toHaveBeenCalledWith('s');
  } finally {
    dispose();
    opened.provision.mockReset();
    runInAction(() => ready.set(true));
  }
});

it('does not revive an archived task while waiting to open it', async () => {
  ready.set(false);
  opened.archived = true;
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.provision).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  } finally {
    dispose();
    opened.archived = false;
    runInAction(() => ready.set(true));
  }
});
