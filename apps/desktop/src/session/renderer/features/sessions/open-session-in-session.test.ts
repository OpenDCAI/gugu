import { describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';

const opened = vi.hoisted(() => ({ calls: [] as unknown[], tabs: 0, views: [] as string[], provisioned: true, archived: false, missing: false, provision: vi.fn(), reason: null as string | null, deviceId: 'host' as string | null, cloud: false }));
const ready = observable.box(true);
const registryState = observable({ present: true, loading: false, data: [{ id: 's' }], error: undefined as string | undefined });
let liveManager: import('./page-sessions-store').PageSessionsStore | undefined;
const hostState = observable({ view: true, kind: 'ready', opening: false, error: null as string | null });
const machineReason = observable.box<string | null>(null);
const listed = vi.hoisted(() => ({ nativeInputVersion: undefined as number | undefined }));

vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    cloudScope: () => opened.cloud ? { state: 'asleep' } : null,
    findListedSession: () => { throw new Error('Input eligibility must not read the directory'); },
  },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => opened.deviceId } }));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => {
  const paneLayout = {
    get groups() {
      return [{ pane: { tabOrder: Array.from({ length: opened.tabs }, (_, i) => `t${i}`), entries: new Map() } }];
    },
    open: (...args: unknown[]) => opened.calls.push(args),
  };
  return {
    asProvisioned: (page: unknown) => page,
    getSessionPageStore: (_project: string, id: string) => id === 'owner' ? (hostState.view ? { viewModel: {} } : null) : (!opened.missing && opened.provisioned && ready.get() ? { viewModel: {} } : null),
    getSessionView: (projectId: string, sessionId: string) => {
      opened.views.push(`${projectId}/${sessionId}`);
      return sessionId === 'owner' && !hostState.view ? undefined : { paneLayout };
    },
    getSessionManagerStore: () => ({ provisionSession: opened.provision }),
    sessionViewKind: (_page: unknown, project: string) => project === 'beside' ? hostState.kind : opened.archived ? 'archived' : opened.missing ? 'missing' : 'idle',
    sessionErrorMessage: () => hostState.error ?? opened.reason,
    projectMountErrorMessage: () => 'Project failed to open',
  };
});
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ mountProject: vi.fn().mockResolvedValue(undefined) }), getProjectStore: () => ({ phase: hostState.opening ? 'opening' : 'idle' }) }));
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: { get: () => liveManager ?? ({ list: registryState, sessions: { get: () => registryState.present ? { data: { runtime: 'pty' } } : undefined } }) },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (k: string) => k }));

vi.mock('./workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => opened.reason }));
vi.mock('./machine-unavailable-label', () => ({ machineUnavailableLabel: () => machineReason.get() }));

import { toast } from '@renderer/lib/hooks/use-toast';
import { openSessionInSessionWhenReady } from './open-session-in-session';
import * as preparation from './session-pane-ready';

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
    expect(opened.calls).toEqual([['session', { sessionId: 'agent-2', projectId: 'other-project', ownerSessionId: 'agent-2' }, { from: null, intent: 'newTab' }]]);
    expect(new Set(opened.views)).toEqual(new Set(['p/agent-1']));
  });
});

describe('task entry keeps the preparation failure reason', () => {
  it.each([undefined, 1, 2])('opens an offline task with native version %s without preparing or waiting for its workspace', async (version) => {
    await Promise.resolve();
    await Promise.resolve();
    opened.provision.mockClear();
    vi.useFakeTimers();
    vi.mocked(toast).mockClear();
    opened.calls = [];
    opened.provisioned = false;
    runInAction(() => machineReason.set('Remote host is offline'));
    listed.nativeInputVersion = version;
    const onReady = vi.fn();
    const prepare = vi.spyOn(preparation, 'whenSessionPaneReady');
    const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
    try {
      expect(onReady).toHaveBeenCalledOnce();
      await Promise.resolve();
      await Promise.resolve();
      expect(opened.provision).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(opened.calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      dispose();
      prepare.mockRestore();
      opened.provisioned = true;
      runInAction(() => machineReason.set(null));
      listed.nativeInputVersion = undefined;
      vi.useRealTimers();
    }
  });


  it.each([
    ['cloud', 'Gugu on cloud host is too old. Update Gugu there'],
    ['ssh', 'Gugu on SSH host is too old. Update Gugu there'],
    ['offline', 'The remote machine is offline'],
    ['local', 'The workspace could not be prepared'],
  ])('%s entry reports the actual failed operation', async (_route, reason) => {
    vi.mocked(toast).mockClear();
    opened.provisioned = false;
    opened.provision.mockRejectedValueOnce(new Error(reason));
    const onReady = vi.fn();
    const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
    try {
      await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: reason })));
      expect(onReady).not.toHaveBeenCalled();
    } finally {
      dispose();
      opened.provisioned = true;
      opened.provision.mockReset();
    }
  });
});

it('reports the offline host when its machine id is unavailable for offline input', async () => {
  opened.deviceId = null;
  vi.mocked(toast).mockClear();
  opened.calls = [];
  runInAction(() => {
    ready.set(false);
    machineReason.set('The remote machine is offline');
  });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'The remote machine is offline' }));
    runInAction(() => {
      machineReason.set(null);
      ready.set(true);
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(opened.calls).toHaveLength(0);
  } finally {
    dispose();
    opened.deviceId = 'host';
    runInAction(() => { machineReason.set(null); ready.set(true); });
  }
});

it.each([true, false])('disposes a fork wait after the host becomes unavailable (initially offline: %s)', initiallyOffline => {
  runInAction(() => {
    ready.set(false);
    machineReason.set(initiallyOffline ? 'The remote machine is offline' : null);
  });
  const fork = vi.fn();
  const onError = vi.fn();
  const dispose = preparation.whenSessionPaneReady('p', 's', fork, { onError });
  try {
    if (!initiallyOffline) {
      expect(onError).not.toHaveBeenCalled();
      runInAction(() => machineReason.set('The remote machine is offline'));
    }
    expect(onError).toHaveBeenCalledExactlyOnceWith('The remote machine is offline');
    runInAction(() => {
      machineReason.set(null);
      ready.set(true);
    });
    expect(fork).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  } finally {
    dispose();
    runInAction(() => { machineReason.set(null); ready.set(true); });
  }
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
  vi.mocked(toast).mockClear();
  opened.provision.mockClear();
  ready.set(false);
  opened.archived = true;
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.provision).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'task.archivedToast' }));
    expect(onReady).not.toHaveBeenCalled();
    opened.archived = false;
    runInAction(() => ready.set(true));
    expect(onReady).not.toHaveBeenCalled();
  } finally {
    dispose();
    opened.archived = false;
    runInAction(() => ready.set(true));
  }
});

it('reports a missing task immediately even when preparation resolves, without a late open', async () => {
  vi.mocked(toast).mockClear();
  opened.missing = true;
  ready.set(false);
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 'missing', onReady });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'task.notFound' }));
    expect(onReady).not.toHaveBeenCalled();
    opened.missing = false;
    runInAction(() => ready.set(true));
    expect(onReady).not.toHaveBeenCalled();
  } finally {
    dispose();
    opened.missing = false;
    runInAction(() => ready.set(true));
  }
});

it('shows a failed preparation immediately and offers the same open as a retry', async () => {
  vi.mocked(toast).mockClear();
  ready.set(false);
  opened.provisioned = false;
  opened.provision.mockRejectedValueOnce(new Error('The remote session host disconnected'));
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's' });
  try {
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: 'The remote session host disconnected',
      action: expect.objectContaining({ onClick: expect.any(Function) }),
    })));
  } finally {
    dispose();
    opened.provisioned = true;
    opened.provision.mockReset();
    runInAction(() => ready.set(true));
  }
});

it('continues waiting while preparation is active instead of adding an opening deadline', async () => {
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
  ready.set(false);
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toast).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    runInAction(() => ready.set(true));
    expect(onReady).toHaveBeenCalledOnce();
  } finally {
    dispose();
    runInAction(() => ready.set(true));
    vi.useRealTimers();
  }
});

it('keeps cloud wake on the ordinary workspace preparation path', () => {
  opened.cloud = true;
  runInAction(() => machineReason.set('Cloud host is asleep'));
  const prepare = vi.spyOn(preparation, 'whenSessionPaneReady');
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', host: { projectId: 'beside', sessionId: 'owner' } });
  try { expect(prepare).toHaveBeenCalledOnce(); }
  finally { dispose(); prepare.mockRestore(); opened.cloud = false; runInAction(() => machineReason.set(null)); }
});

it('accepts missing-version beside navigation without waiting for either workspace', () => {
  opened.provisioned = false;
  runInAction(() => machineReason.set('Remote host offline'));
  opened.calls = [];
  const prepare = vi.spyOn(preparation, 'whenSessionPaneReady');
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', host: { projectId: 'beside', sessionId: 'owner' }, onReady });
  try {
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(opened.calls).toEqual([]);
  } finally { dispose(); prepare.mockRestore(); opened.provisioned = true; runInAction(() => machineReason.set(null)); }
});


it.each(['loaded', 'missing', 'error'] as const)('settles a cold registry load after the workspace arrives: %s', (outcome) => {
  vi.mocked(toast).mockClear();
  opened.calls = [];
  runInAction(() => { registryState.present = false; registryState.loading = true; });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  try {
    expect(toast).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    runInAction(() => {
      registryState.loading = false;
      registryState.present = outcome === 'loaded';
      registryState.data = outcome === 'loaded' ? [{ id: 's' }] : [];
      registryState.error = outcome === 'error' ? 'Conversation lookup failed' : undefined;
    });
    if (outcome === 'loaded') {
      expect(onReady).toHaveBeenCalledOnce();
      expect(opened.calls).toHaveLength(1);
      expect(toast).not.toHaveBeenCalled();
    } else {
      expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: outcome === 'error' ? 'Conversation lookup failed' : 'sidebar.workspaceNotReady',
      }));
      runInAction(() => { registryState.present = true; });
      expect(onReady).not.toHaveBeenCalled();
      expect(opened.calls).toHaveLength(0);
    }
  } finally {
    dispose();
    runInAction(() => { registryState.present = true; registryState.loading = false; registryState.error = undefined; });
  }
});

it.each(['loaded', 'missing', 'error'] as const)('settles the host workspace after its preparation phase: %s', (outcome) => {
  vi.mocked(toast).mockClear();
  opened.calls = [];
  runInAction(() => { hostState.view = false; hostState.kind = 'provisioning'; });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', host: { projectId: 'beside', sessionId: 'owner' }, onReady });
  try {
    expect(onReady).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    runInAction(() => {
      hostState.view = outcome === 'loaded';
      hostState.kind = outcome === 'loaded' ? 'ready' : outcome === 'error' ? 'provision-error' : 'missing';
      hostState.error = outcome === 'error' ? 'Host workspace failed' : null;
    });
    if (outcome === 'loaded') {
      expect(onReady).toHaveBeenCalledOnce();
      expect(opened.calls).toHaveLength(1);
      expect(toast).not.toHaveBeenCalled();
    } else {
      expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: outcome === 'error' ? 'Host workspace failed' : 'sidebar.workspaceNotReady',
      }));
      runInAction(() => { hostState.view = true; });
      expect(onReady).not.toHaveBeenCalled();
    }
  } finally {
    dispose();
    runInAction(() => { hostState.view = true; hostState.kind = 'ready'; hostState.error = null; });
  }
});


it('ends an empty-block fill when its prepared conversation is absent, without a late tab', async () => {
  const { keepBlockFilled } = await import('./view/keep-block-filled');
  vi.mocked(toast).mockClear();
  opened.calls = [];
  runInAction(() => { registryState.present = false; registryState.loading = true; });
  const dispose = keepBlockFilled({
    empty: () => true, alone: () => false, close: vi.fn(),
    fill: () => openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true }),
  });
  try {
    expect(toast).not.toHaveBeenCalled();
    runInAction(() => { registryState.loading = false; registryState.data = []; });
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'sidebar.workspaceNotReady' }));
    runInAction(() => { registryState.present = true; });
    expect(opened.calls).toHaveLength(0);
  } finally {
    dispose();
    runInAction(() => { registryState.present = true; registryState.loading = false; });
  }
});


it('does not mistake an unmounted idle host for an active host load', () => {
  vi.mocked(toast).mockClear();
  runInAction(() => { hostState.view = false; hostState.kind = 'project-mounting'; });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', host: { projectId: 'beside', sessionId: 'owner' }, onReady });
  try {
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'sidebar.workspaceNotReady' }));
    runInAction(() => { hostState.view = true; });
    expect(onReady).not.toHaveBeenCalled();
  } finally { dispose(); runInAction(() => { hostState.view = true; hostState.kind = 'ready'; }); }
});

it('waits for an actively mounting host and settles when mounting ends without a view', () => {
  vi.mocked(toast).mockClear();
  runInAction(() => { hostState.view = false; hostState.kind = 'project-mounting'; hostState.opening = true; });
  const onReady = vi.fn();
  const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', host: { projectId: 'beside', sessionId: 'owner' }, onReady });
  try {
    expect(toast).not.toHaveBeenCalled();
    runInAction(() => { hostState.opening = false; });
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'sidebar.workspaceNotReady' }));
    expect(onReady).not.toHaveBeenCalled();
  } finally { dispose(); runInAction(() => { hostState.view = true; hostState.kind = 'ready'; hostState.opening = false; }); }
});


const lookup = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessions: { getUnarchivedSession: (...args: unknown[]) => lookup.fetch(...args) } }, onMachineEvent: () => () => {} }));
vi.mock('@renderer/lib/pty/pty-session', () => ({ PtySession: class { destroy() {} } }));
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({ makeFileLinkHandlers: () => ({ onOpenFile: vi.fn(), onOpenExternal: vi.fn() }) }));

it.each(['loaded', 'missing', 'error'] as const)('settles a real non-preloaded demand registry created in an action: %s', async (outcome) => {
  const { PageSessionsStore } = await import('./page-sessions-store');
  type Session = import('@shared/core/sessions/sessions').Session;
  let resolve!: (rows: Session[]) => void;
  let reject!: (error: Error) => void;
  lookup.fetch.mockReturnValueOnce(new Promise<Session[]>((yes, no) => { resolve = yes; reject = no; }));
  vi.mocked(toast).mockClear();
  opened.calls = [];
  const onReady = vi.fn();
  let dispose!: () => void;
  runInAction(() => {
    liveManager = new PageSessionsStore('p', 's');
    dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onReady });
  });
  try {
    expect(lookup.fetch).toHaveBeenCalledWith('p', 's');
    expect(toast).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    if (outcome === 'error') reject(new Error('Demand lookup failed'));
    else resolve(outcome === 'loaded' ? [{ id: 's', projectId: 'p', runtime: 'pty' } as Session] : []);
    if (outcome === 'loaded') {
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      expect(opened.calls).toHaveLength(1);
      expect(toast).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: outcome === 'error' ? 'Demand lookup failed' : 'sidebar.workspaceNotReady',
      })));
      expect(onReady).not.toHaveBeenCalled();
    }
  } finally { dispose(); liveManager?.dispose(); liveManager = undefined; }
});
