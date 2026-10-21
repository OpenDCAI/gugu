/**
 * #6264 升级上来的机器:重启前就有的会话,它的项目在新进程里还没被打开时,唤醒它(MCP 旧卡来敲门、云端投递)
 * 要当场把项目打开,❌ 报 `Project … not found`。
 *
 * 现场(2026-09-25 d22,server 0.2.157):两条会话建在旧版远端建会话用的 `task-home` 项目里(随机 id,
 * 目录 ~/.config/咕咕/task-home,不是固定 id 的隐藏任务工作区)。重启后它们在 tmux 里的 agent 6 秒内拿旧卡来敲门,
 * 那时启动时的 `openAllEmdashProjects` 还没打开这个项目 → 唤醒失败 → MCP 回 401 → 这条会话里的咕咕工具全部失效。
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: new Map<string, unknown>() }));

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: (id: string) => mocks.open.get(id) },
}));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));
vi.mock('@main/core/sessions/session-builder', () => ({ buildSessionFromWorkspace: vi.fn(), emitSessionProvisionProgress: vi.fn() }));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { log };
});

const { WorkspaceBootstrapService } = await import('./workspace-bootstrap-service');

const OLD_SESSION_HOME = '89648ac1-68dd-4d63-b473-b83eeee942e7';

/** 只回答这一问要的那两行:会话行、工作区行。 */
function fakeDb() {
  const rows = [
    [{ id: 'session-1', projectId: OLD_SESSION_HOME, workspaceId: 'ws-1', title: 'late-cooks-wave' }],
    [{ id: 'ws-1', type: 'local', kind: null, path: '/root/.config/咕咕/task-home', config: null }],
  ];
  let call = 0;
  const chain = { from: () => chain, where: () => chain, limit: async () => rows[call++] ?? [] };
  return { select: () => chain } as never;
}

describe('ensureWorkspaceSetupForSession on a machine that was just upgraded and restarted', () => {
  it('opens a project that is not open yet, then sets the workspace up', async () => {
    mocks.open.clear();
    const provider = { repoPath: '/root/.config/咕咕/task-home' };
    const openOnDemand = vi.fn(async (id: string) => {
      mocks.open.set(id, provider);
      return provider as never;
    });
    const service = new WorkspaceBootstrapService(fakeDb(), openOnDemand);
    const setup = vi.spyOn(service, 'ensureWorkspaceSetup').mockResolvedValue({ success: true, data: {} } as never);

    await service.ensureWorkspaceSetupForSession('session-1');

    expect(openOnDemand).toHaveBeenCalledWith(OLD_SESSION_HOME);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![2]).toBe(provider);
  });

  it('does not reopen a project that is already open', async () => {
    mocks.open.clear();
    const provider = { repoPath: '/x' };
    mocks.open.set(OLD_SESSION_HOME, provider);
    const openOnDemand = vi.fn();
    const service = new WorkspaceBootstrapService(fakeDb(), openOnDemand);
    vi.spyOn(service, 'ensureWorkspaceSetup').mockResolvedValue({ success: true, data: {} } as never);

    await service.ensureWorkspaceSetupForSession('session-1');

    expect(openOnDemand).not.toHaveBeenCalled();
  });

  it('still says the project is missing when it cannot be opened (no such row, folder gone)', async () => {
    mocks.open.clear();
    const service = new WorkspaceBootstrapService(fakeDb(), async () => null);
    await expect(service.ensureWorkspaceSetupForSession('session-1')).rejects.toThrow(`Project ${OLD_SESSION_HOME} not found`);
  });
});
