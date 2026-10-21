import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProjectWorkspace, releaseProjectWorkspace } from './project-workspace-lease';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  acquire: vi.fn(),
  teardown: vi.fn(),
  listForProject: vi.fn(),
  createWorkspaceFactory: vi.fn(),
  resolveProjectFolder: vi.fn(),
}));

vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));

vi.mock('@main/core/workspaces/workspace-factory', () => ({
  createWorkspaceFactory: mocks.createWorkspaceFactory,
}));

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    acquire: mocks.acquire,
    teardown: mocks.teardown,
    listForProject: mocks.listForProject,
  },
}));

vi.mock('../project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

vi.mock('./getProjects', () => ({ getProjectById: mocks.getProjectById }));

vi.mock('./project-folders', () => ({ resolveProjectFolder: mocks.resolveProjectFolder }));

const projectGitRepository = { repo: 'project-1' };
const projectFetchService = { fetch: 'project-1' };

describe('project workspace lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      name: 'Project 1',
      repositoryWorkspaceId: 'workspace-1',
    });
    mocks.getProject.mockReturnValue({
      repoPath: '/tmp/project-1',
      settings: {},
      isGitless: false,
      gitRepository: projectGitRepository,
      gitRepositoryFetchService: projectFetchService,
    });
    mocks.resolveProjectFolder.mockResolvedValue(null);
    mocks.createWorkspaceFactory.mockReturnValue(vi.fn());
    mocks.acquire.mockResolvedValue({ workspace: { id: 'workspace-1' } });
    mocks.listForProject.mockReturnValue([{ workspaceId: 'workspace-1', path: '/tmp/project-1' }]);
    mocks.teardown.mockResolvedValue(undefined);
  });

  it('acquires the repository workspace before draft file tools use it', async () => {
    const result = await acquireProjectWorkspace('project-1', 'workspace-1');

    expect(result).toEqual({ success: true, data: { workspaceId: 'workspace-1' } });
    expect(mocks.acquire).toHaveBeenCalledWith('workspace-1', 'project-1', expect.any(Function));
    expect(mocks.createWorkspaceFactory).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({
        workDir: '/tmp/project-1',
        projectId: 'project-1',
        projectPath: '/tmp/project-1',
        gitless: false,
        gitRepository: projectGitRepository,
        gitRepositoryFetchService: projectFetchService,
      })
    );
    // 根目录不问「挂上的文件夹」那张表,也不改 git 复查的目录
    expect(mocks.resolveProjectFolder).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceFactory.mock.calls[0]![1]).not.toHaveProperty('gitProbePath');
  });

  // #7341 点项目首页里挂上的那个文件夹:草稿工作区就在那个文件夹里,git 照它自己的目录判,❌ 借根目录的 git 服务。
  it('acquires a folder attached to the project in that folder, with its own git', async () => {
    mocks.resolveProjectFolder.mockResolvedValue({
      kind: 'attached',
      path: '/tmp/project-1-worktree',
      workspaceKind: 'path',
    });
    mocks.acquire.mockResolvedValue({ workspace: { id: 'workspace-attached' } });

    const result = await acquireProjectWorkspace('project-1', 'workspace-attached');

    expect(result).toEqual({ success: true, data: { workspaceId: 'workspace-attached' } });
    expect(mocks.resolveProjectFolder).toHaveBeenCalledWith('project-1', 'workspace-attached');
    expect(mocks.acquire).toHaveBeenCalledWith('workspace-attached', 'project-1', expect.any(Function));
    const context = mocks.createWorkspaceFactory.mock.calls[0]![1];
    expect(context).toMatchObject({
      workDir: '/tmp/project-1-worktree',
      projectId: 'project-1',
      projectPath: '/tmp/project-1',
      gitless: false,
      gitProbePath: '/tmp/project-1-worktree',
    });
    expect(context.gitRepository).toBeUndefined();
    expect(context.gitRepositoryFetchService).toBeUndefined();
  });

  it('rejects a workspace that is neither the project root nor attached to the project', async () => {
    const result = await acquireProjectWorkspace('project-1', 'other-workspace');

    expect(result).toEqual({
      success: false,
      error: { type: 'not-found', message: 'Project workspace not found' },
    });
    expect(mocks.resolveProjectFolder).toHaveBeenCalledWith('project-1', 'other-workspace');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('releases only a workspace currently owned by the project', async () => {
    expect(await releaseProjectWorkspace('project-1', 'workspace-1')).toEqual({ success: true });
    expect(mocks.teardown).toHaveBeenCalledWith('workspace-1', 'detach');

    mocks.listForProject.mockReturnValue([]);
    expect(await releaseProjectWorkspace('project-1', 'other-workspace')).toEqual({
      success: true,
    });
    expect(mocks.teardown).toHaveBeenCalledTimes(1);
  });
});
