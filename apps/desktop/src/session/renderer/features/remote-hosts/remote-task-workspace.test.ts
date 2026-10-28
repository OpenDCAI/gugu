// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSessionHomeDir: vi.fn(async () => '/root/.config/咕咕/task-home') }));

vi.mock('@renderer/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ipc')>()),
  rpcOn: () => ({ app: { getSessionHomeDir: mocks.getSessionHomeDir } }),
}));

const TASK_WORKSPACE = '00000000-0000-4000-8000-000000000001';

// #609(owner 10-28):别的机器上没选文件夹 ⇒ 那台机器的任务工作区(与本机一样列在「任务」),❌ 在那台机器上把 ~ 建成项目。
describe('没选文件夹 = 那台机器的任务工作区', () => {
  afterEach(() => vi.restoreAllMocks());

  it('还没有:用固定 id 在那台机器上的别名建在它的 task-home(❌ 主目录),同时要两次只建一次', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { RemoteHostsStore } = await import('./remote-hosts-store');
    const store = new RemoteHostsStore();
    const create = vi.spyOn(appState.projects, 'createProject').mockImplementation(async (_type, _data, id) => id);
    const mount = vi.spyOn(appState.projects, 'ensureMounted').mockResolvedValue(undefined as never);

    const [a, b] = await Promise.all([store.ensureTaskWorkspace('d22'), store.ensureTaskWorkspace('d22')]);
    expect(a).toBe(`${TASK_WORKSPACE}~d22`);
    expect(b).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { type: 'local', machine: 'd22' },
      expect.objectContaining({ mode: 'pick', path: '/root/.config/咕咕/task-home', allowNonGit: true }),
      `${TASK_WORKSPACE}~d22`
    );
    expect(mount).toHaveBeenCalledWith(`${TASK_WORKSPACE}~d22`);
  });

  it('比这一版旧的 server 不回 getSessionHomeDir:照旧落在它的主目录项目里,❌ 新建框卡在「连不上」', async () => {
    const { RemoteHostsStore } = await import('./remote-hosts-store');
    const store = new RemoteHostsStore();
    mocks.getSessionHomeDir.mockRejectedValueOnce(new Error('denied'));
    const home = vi.spyOn(store, 'ensureHomeProject').mockResolvedValue('home-on-old-server');

    await expect(store.ensureTaskWorkspace('d25')).resolves.toBe('home-on-old-server');
    expect(home).toHaveBeenCalledWith('d25');
  });

  it('已经有了:挂上就用,❌ 再建', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { RemoteHostsStore } = await import('./remote-hosts-store');
    const id = `${TASK_WORKSPACE}~d23`;
    appState.projects.projects.set(id, { id, data: { path: '/x/task-home' } } as never);
    const create = vi.spyOn(appState.projects, 'createProject');
    vi.spyOn(appState.projects, 'ensureMounted').mockResolvedValue(undefined as never);

    await expect(new RemoteHostsStore().ensureTaskWorkspace('d23')).resolves.toBe(id);
    expect(create).not.toHaveBeenCalled();
    appState.projects.projects.delete(id);
  });

  it('新建框没选文件夹走它;选了文件夹(哪怕是 ~)照常是那台机器上的项目', async () => {
    const { remoteHostsStore } = await import('./remote-hosts-store');
    const { resolveMachineProject } = await import('@renderer/features/sessions/use-machine-create-target');
    const tasks = vi.spyOn(remoteHostsStore, 'ensureTaskWorkspace').mockResolvedValue('tw');
    const project = vi.spyOn(remoteHostsStore, 'ensureProject').mockResolvedValue('p');

    await expect(resolveMachineProject({ deviceId: 'd24', projectPath: null })).resolves.toBe('tw');
    await expect(resolveMachineProject({ deviceId: 'd24', projectPath: '/root' })).resolves.toBe('p');
    expect(project).toHaveBeenCalledWith('d24', '/root');
    expect(tasks).toHaveBeenCalledTimes(1);
  });
});
