/**
 * #7341 会话从项目挂的文件夹开工:就在那个文件夹的路径里跑(终端、ACP 的 cwd 都取挂载出来的工作区路径),
 * git 跟着那个文件夹走 —— ❌ 借根目录那个仓库的 git 服务,❌ 按根目录判「是不是 git」。
 * 根目录那一格是对照:项目自己的 git 服务原样注入,复查目录不改。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorkspaceFactory: vi.fn(),
  acquire: vi.fn(),
  teardown: vi.fn(),
  buildSessionFromWorkspace: vi.fn(),
}));

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => undefined } }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));
vi.mock('@main/core/sessions/session-builder', () => ({
  buildSessionFromWorkspace: mocks.buildSessionFromWorkspace,
  emitSessionProvisionProgress: vi.fn(),
}));
vi.mock('./workspace-factory', () => ({ createWorkspaceFactory: mocks.createWorkspaceFactory }));
vi.mock('./workspace-registry', () => ({
  workspaceRegistry: { acquire: mocks.acquire, teardown: mocks.teardown },
}));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { log };
});

const { WorkspaceBootstrapService } = await import('./workspace-bootstrap-service');

const projectGitRepository = { repo: 'root' };
const projectFetchService = { fetch: 'root' };
const project = {
  projectId: 'project-1',
  repoPath: '/work/gugu',
  defaultWorkspaceType: { kind: 'local' },
  defaultWorkspaceMachine: { kind: 'local' },
  settings: {},
  isGitless: false,
  gitRepository: projectGitRepository,
  gitRepositoryFetchService: projectFetchService,
};

describe('ensureWorkspaceSetup for a project folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorkspaceFactory.mockReturnValue(vi.fn());
    mocks.acquire.mockImplementation(async (workspaceId: string) => ({
      workspace: { id: workspaceId, path: 'from-factory' },
    }));
    mocks.buildSessionFromWorkspace.mockResolvedValue({ sessionMount: { sessionPath: 'mounted' } });
  });

  async function setUp(row: { id: string; kind: string; path: string }) {
    const service = new WorkspaceBootstrapService({} as never, async () => null);
    const result = await service.ensureWorkspaceSetup(
      { ...row, type: 'local' },
      { id: 'session-1', title: 'fix it' },
      project as never
    );
    const [workspaceId, context] = mocks.createWorkspaceFactory.mock.calls[0]!;
    return { result, workspaceId, context };
  }

  it('a folder attached to the project: runs in that folder, git judged and served from that folder', async () => {
    const { result, workspaceId, context } = await setUp({
      id: 'ws-attached',
      kind: 'path',
      path: '/work/gugu-7341',
    });

    expect(result).toMatchObject({ success: true, data: { path: '/work/gugu-7341', workspaceId: 'ws-attached' } });
    expect(workspaceId).toBe('ws-attached');
    expect(context).toMatchObject({
      workDir: '/work/gugu-7341',
      projectPath: '/work/gugu',
      gitless: false,
      gitProbePath: '/work/gugu-7341',
    });
    expect(context.gitRepository).toBeUndefined();
    expect(context.gitRepositoryFetchService).toBeUndefined();
  });

  it('control — the project root: project git services as before, re-check stays on the project path', async () => {
    const { result, context } = await setUp({ id: 'ws-root', kind: 'project-root', path: '/work/gugu' });

    expect(result).toMatchObject({ success: true, data: { path: '/work/gugu', workspaceId: 'ws-root' } });
    expect(context).toMatchObject({
      workDir: '/work/gugu',
      projectPath: '/work/gugu',
      gitless: false,
      gitRepository: projectGitRepository,
      gitRepositoryFetchService: projectFetchService,
    });
    expect(context).not.toHaveProperty('gitProbePath');
  });
});
