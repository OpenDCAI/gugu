import { ok } from '@gugu/session-shared';
import { when } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { projectSettingsChangedChannel } from '@shared/core/projects/projectEvents';
import { lifecycleScriptStatusChannel } from '@shared/core/sessions/provisionEvents';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import { LifecycleScriptsStore, LifecycleScriptStore } from './lifecycle-scripts';

const eventHandlers = new Map<string, (data: unknown) => void>();
const offEvent = vi.fn();
const getSettings = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => {
  const ipc = {
  events: {
    on: vi.fn((event: { name: string }, cb: (data: unknown) => void, topic?: string) => {
      eventHandlers.set(`${event.name}.${topic ?? ''}`, cb);
      return offEvent;
    }),
  },
  rpc: {
    projectSettings: {
      getSettings,
    },
  },
};
  // 本机(null)那条线就是 events.on;测试里的项目都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
});

vi.mock('@renderer/lib/pty/pty-session', () => ({
  PtySession: class {
    pty = null;
    status = 'disconnected';

    constructor(readonly ptySessionId: string) {}

    connect = vi.fn(async () => {});
    dispose = vi.fn();
    destroy = vi.fn();
  },
}));

describe('LifecycleScriptStore', () => {
  beforeEach(() => {
    eventHandlers.clear();
    offEvent.mockClear();
    getSettings.mockReset();
  });

  it('tracks script running state from lifecycle status events', () => {
    const store = new LifecycleScriptStore(
      { id: 'script-id', type: 'run', label: 'Run', command: 'pnpm dev' },
      'project-1',
      'branch:feature'
    );

    expect(store.isRunning).toBe(false);

    eventHandlers.get(`${lifecycleScriptStatusChannel.name}.`)?.({
      projectId: 'project-1',
      workspaceId: 'branch:feature',
      type: 'run',
      origin: 'manual',
      status: 'running',
    });

    expect(store.isRunning).toBe(true);
    expect(store.status).toBe('running');

    eventHandlers.get(`${lifecycleScriptStatusChannel.name}.`)?.({
      projectId: 'project-1',
      workspaceId: 'branch:feature',
      type: 'run',
      origin: 'manual',
      status: 'succeeded',
      exitCode: 0,
    });

    expect(store.isRunning).toBe(false);
    expect(store.status).toBe('succeeded');
  });

  it('unsubscribes from lifecycle status events on dispose', () => {
    const store = new LifecycleScriptStore(
      { id: 'script-id', type: 'run', label: 'Run', command: 'pnpm dev' },
      'project-1',
      'branch:feature'
    );

    store.dispose();

    expect(offEvent).toHaveBeenCalledTimes(1);
  });
});

describe('LifecycleScriptsStore', () => {
  beforeEach(() => {
    eventHandlers.clear();
    offEvent.mockClear();
    getSettings.mockReset();
  });

  it('uses stable script IDs and reconciles command changes from .emdash.json watch events', async () => {
    getSettings
      .mockResolvedValueOnce(ok({ scripts: { run: 'pnpm dev' } }))
      .mockResolvedValueOnce(ok({ scripts: { run: 'pnpm start' } }));
    const store = new LifecycleScriptsStore('project-1', 'workspace-1');

    await (store as unknown as { load(): Promise<void> }).load();

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].data.id).toBe(createLifecycleScriptTerminalId('run'));
    expect(store.tabs[0].data.command).toBe('pnpm dev');

    eventHandlers.get(`${fileChangesChannel.name}.`)?.({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      update: {
        kind: 'changes',
        changes: [{ kind: 'update', entryType: 'file', path: '.emdash.json' }],
      },
    });

    // 事件触发的重读是异步的;脚本表是 mobx 观察值 —— 等它换成新命令。
    await when(() => store.tabs[0]?.data.command !== 'pnpm dev');
    expect(store.tabs[0]?.data.command).toBe('pnpm start');
    expect(store.tabs[0].data.id).toBe(createLifecycleScriptTerminalId('run'));

    store.dispose();
  });

  it('reloads lifecycle scripts when project settings change', async () => {
    getSettings
      .mockResolvedValueOnce(ok({ scripts: { setup: 'pnpm install' } }))
      .mockResolvedValueOnce(ok({ scripts: { setup: 'corepack install', run: 'pnpm dev' } }));
    const store = new LifecycleScriptsStore('project-1', 'workspace-1');

    await (store as unknown as { load(): Promise<void> }).load();

    eventHandlers.get(`${projectSettingsChangedChannel.name}.`)?.({ projectId: 'project-1' });

    // 等「脚本表换过了」再断言确切内容:重读在 runInAction 里整体替换,不会停在中间态。
    // ❌ 等 `length === 2` —— 回归成别的形状时那个条件永远不成立,用例挂住而不是判红。
    const commands = () => store.tabs.map((tab) => tab.data.command);
    await when(() => commands().join('\n') !== 'pnpm install');
    expect(commands()).toEqual(['corepack install', 'pnpm dev']);
  });

  it('does not recreate script sessions when an in-flight load completes after dispose', async () => {
    let resolveSettings: (settings: unknown) => void = () => {};
    getSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      })
    );
    const store = new LifecycleScriptsStore('project-1', 'workspace-1');

    const loadPromise = (store as unknown as { load(): Promise<void> }).load();
    store.dispose();
    resolveSettings(ok({ scripts: { run: 'pnpm dev' } }));
    await loadPromise;

    expect(store.tabs).toEqual([]);
  });

  it('keeps lifecycle script tabs empty when settings fail to load', async () => {
    getSettings.mockResolvedValue({
      success: false,
      error: { type: 'fs_error', message: 'filesystem unavailable' },
    });
    const store = new LifecycleScriptsStore('project-1', 'workspace-1');

    await (store as unknown as { load(): Promise<void> }).load();

    expect(store.tabs).toEqual([]);
  });
});
