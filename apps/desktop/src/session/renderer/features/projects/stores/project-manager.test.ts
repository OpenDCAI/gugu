import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import { projectCreatedChannel, projectDeletedChannel, projectVisibilityChangedChannel } from '@shared/core/projects/projectEvents';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import type { LocalProject } from '@shared/projects';
// 这个模块被 vi.mock 掉了,导进来拿到的就是那份替身 —— 挂载末尾补跑的 revalidate 打在它上面。
import { appState } from '@renderer/lib/stores/app-state';
import { createUnmountedProject, isUnregisteredProject } from './project';
import { ProjectPathConflictError } from './project-creation-error';
import { ProjectManagerStore } from './project-manager';

const mocks = vi.hoisted(() => ({
  cloneRepository: vi.fn(),
  createGithubRepository: vi.fn(),
  createProject: vi.fn(),
  deleteGithubRepository: vi.fn(),
  initializeRepository: vi.fn(),
  inspectProjectPath: vi.fn(),
  getProjects: vi.fn(),
  getUnarchivedSession: vi.fn(),
  logError: vi.fn(),
  openProject: vi.fn(),
  patchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  eventOn: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => {
  const mod = {
  events: {
    on: mocks.eventOn,
  },
  rpc: {
    sessions: {
      getUnarchivedSession: mocks.getUnarchivedSession,
    },
    github: {
      createRepository: mocks.createGithubRepository,
      deleteRepository: mocks.deleteGithubRepository,
    },
    projectSetup: {
      cloneRepository: mocks.cloneRepository,
      initializeRepository: mocks.initializeRepository,
    },
    projects: {
      createProject: mocks.createProject,
      getProjects: mocks.getProjects,
      inspectProjectPath: mocks.inspectProjectPath,
      openProject: mocks.openProject,
      patchProjectSettings: mocks.patchProjectSettings,
      updateProjectSettings: mocks.updateProjectSettings,
    },
  },
  };
  // #6264 一套工作台:按机器路由的那几个口,替身里都落到本机这一份。
  return {
    rpcOn: () => mod.rpc,
    eventSourceMachine: () => null,
    onMachineEvent: () => () => {},
    ...mod,
  };
});

// 到别的机器的线:测试里手动开合(ensureMounted 等它连上才挂)。
const links = vi.hoisted(() => ({ state: new Map<string, string>(), listeners: new Map<string, Set<() => void>>() }));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: (deviceId: string) => links.state.get(deviceId) ?? 'closed',
  subscribeMachineLink: (deviceId: string, listener: () => void) => {
    const set = links.listeners.get(deviceId) ?? new Set<() => void>();
    links.listeners.set(deviceId, set);
    set.add(listener);
    return () => set.delete(listener);
  },
  // 这屏的摆法(screen-layout-actions)经会话名那张表引到它:载入时就要有。
  onMachineLinkOpen: () => () => {},
}));
function setLink(deviceId: string, state: string): void {
  links.state.set(deviceId, state);
  for (const listener of [...(links.listeners.get(deviceId) ?? [])]) listener();
}

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      revalidate: vi.fn(),
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: vi.fn(async () => undefined),
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

vi.mock('@renderer/utils/logger', () => ({
  log: { error: mocks.logError },
}));

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project',
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function okProject(project: LocalProject) {
  return { success: true as const, data: project };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'conversation-id',
    projectId: 'project-id',
    providerId: 'codex',
    title: 'Conversation',
    lastInteractedAt: null,
    ...overrides,
  };
}

/**
 * 一个刚好够 mountProject 走完的项目替身:`state: 'unmounted'` 让 isUnmountedProject 认它,
 * transitionToMounted 挂上一个假的 sessionManager,好让挂载末尾那段拿得到它。
 */
function mountableProject(sessionManager: unknown) {
  return {
    state: 'unmounted',
    phase: 'idle',
    data: localProject({ id: 'project-id' }),
    error: undefined,
    errorCode: undefined,
    mountedProject: undefined as unknown,
    // ⚠️ 写 `this` 而不是闭包里的那个对象:projects 是 observable map,塞进去的普通对象会被 MobX
    // 包成代理。闭包写回的是原对象、被测代码读的是代理 —— 于是「挂载完了」这件事它永远看不见,
    // 整段挂载末尾被静默跳过,判据看起来像是功能没跑。
    transitionToMounted(this: { state: string; mountedProject: unknown }) {
      this.state = 'mounted';
      this.mountedProject = { sessionManager };
    },
  };
}

describe('挂载末尾:任务列表到位之后补跑路由校验', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the effective Git capability before mounting an old project', async () => {
    const sessionManager = { loadSessions: vi.fn(async () => {}), provisionSession: vi.fn() };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue({
      success: true, data: { repositoryWorkspaceId: 'existing-workspace', baseRef: null },
    });

    await store.mountProject('project-id');

    expect(store.projects.get('project-id')?.data).toMatchObject({
      baseRef: null, repositoryWorkspaceId: 'existing-workspace',
    });
  });

  // 路由守卫判的是任务列表,而它**第一次**跑是在冷启动恢复快照那一刻 —— 那时项目还没挂载、
  // sessionManager 还不存在,只能一律放行,之后再也不跑。少了这一次补跑,恢复到一个已归档的任务
  // 就会原样停在那儿。顺序也要钉死:先校验、后 provision,反过来就是先把归档任务复活、再问
  // 该不该去。
  it('先 loadSessions、再 revalidate、最后才 provision', async () => {
    const order: string[] = [];
    const sessionManager = {
      loadSessions: vi.fn(() => {
        order.push('load');
        return Promise.resolve();
      }),
      provisionSession: vi.fn(() => {
        order.push('provision');
        return Promise.resolve();
      }),
    };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue(okProject(localProject({ id: 'project-id' })));
    const nav = appState.navigation as unknown as {
      currentViewId: string;
      viewParamsStore: Record<string, unknown>;
      revalidate: ReturnType<typeof vi.fn>;
    };
    nav.currentViewId = 'session';
    nav.viewParamsStore = { session: { projectId: 'project-id', sessionId: 'session-id' } };
    nav.revalidate.mockImplementation(() => order.push('revalidate'));

    await store.mountProject('project-id');

    expect(order).toEqual(['load', 'revalidate', 'provision']);
  });

  // 校验把人踢走了(比如那项任务已归档),就不该再去 provision 它 —— 那正是「把归档任务反向复活」。
  it('校验把人送走之后,不再 provision 那项任务', async () => {
    const sessionManager = {
      loadSessions: vi.fn(() => Promise.resolve()),
      provisionSession: vi.fn(() => Promise.resolve()),
    };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue(okProject(localProject({ id: 'project-id' })));
    const nav = appState.navigation as unknown as {
      currentViewId: string;
      viewParamsStore: Record<string, unknown>;
      revalidate: ReturnType<typeof vi.fn>;
    };
    nav.currentViewId = 'session';
    nav.viewParamsStore = { session: { projectId: 'project-id', sessionId: 'session-id' } };
    nav.revalidate.mockImplementation(() => {
      nav.currentViewId = 'project';
    });

    await store.mountProject('project-id');

    expect(sessionManager.provisionSession).not.toHaveBeenCalled();
  });
});

describe('ProjectManagerStore project creation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
    mocks.inspectProjectPath.mockResolvedValue({ isDirectory: true, isGitRepo: true });
    mocks.getProjects.mockResolvedValue([]);
    mocks.getUnarchivedSession.mockResolvedValue([]);
    mocks.createProject.mockResolvedValue(okProject(localProject()));
    mocks.openProject.mockReturnValue(new Promise(() => {}));
    mocks.cloneRepository.mockReturnValue(new Promise(() => {}));
    mocks.createGithubRepository.mockResolvedValue({
      success: true,
      repoUrl: 'https://github.com/acme/project.git',
      cloneUrl: 'https://github.com/acme/project.git',
      nameWithOwner: 'acme/project',
    });
    mocks.deleteGithubRepository.mockResolvedValue({ success: true });
    mocks.initializeRepository.mockResolvedValue({ success: true });
    mocks.updateProjectSettings.mockResolvedValue({
      success: true,
      data: { githubAccountId: 'github.com:42' },
    });
    mocks.patchProjectSettings.mockResolvedValue({
      success: true,
      data: { githubAccountId: 'github.com:42' },
    });
  });

  it('loads and mounts a project created outside the renderer store', async () => {
    const importedProject = localProject({ id: 'imported-project' });
    mocks.getProjects.mockResolvedValueOnce([importedProject]);
    const store = new ProjectManagerStore();
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);

    await store.ensureProjectLoaded(importedProject.id);

    expect(store.projects.get(importedProject.id)?.data).toEqual(importedProject);
    expect(mount).toHaveBeenCalledWith(importedProject.id);
  });

  it('adds and mounts a project announced after the initial store load', async () => {
    const store = new ProjectManagerStore();
    await store.load();
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    const handler = mocks.eventOn.mock.calls.find(
      ([channel]) => channel === projectCreatedChannel
    )?.[1];
    if (!handler) throw new Error('Expected project-created event subscription');
    const externalProject = localProject({ id: 'external-project' });

    handler({ project: externalProject });

    expect(store.projects.get(externalProject.id)?.data).toEqual(externalProject);
    expect(mount).toHaveBeenCalledWith(externalProject.id);
  });

  it('leaves renderer-owned optimistic creation state in charge of the same project id', () => {
    const store = new ProjectManagerStore();
    const existingProject = localProject({ id: 'optimistic-project' });
    store.projects.set(existingProject.id, createUnmountedProject(existingProject, 'opening'));
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    const handler = mocks.eventOn.mock.calls.find(
      ([channel]) => channel === projectCreatedChannel
    )?.[1];
    if (!handler) throw new Error('Expected project-created event subscription');

    handler({ project: localProject({ id: existingProject.id, name: 'Duplicate' }) });

    expect(store.projects.get(existingProject.id)?.name).toBe(existingProject.name);
    expect(mount).not.toHaveBeenCalled();
  });

  // #7341 第二步:项目在它那台机器上被删(那台自己的窗口、或别的电脑撤销「接进来」),看着的窗口跟着去掉。
  it('drops a project its machine says is gone, and leaves the rest alone', () => {
    const store = new ProjectManagerStore();
    const gone = localProject({ id: 'gone-project' });
    const kept = localProject({ id: 'kept-project' });
    store.projects.set(gone.id, createUnmountedProject(gone, 'idle'));
    store.projects.set(kept.id, createUnmountedProject(kept, 'idle'));
    const handler = mocks.eventOn.mock.calls.find(([channel]) => channel === projectDeletedChannel)?.[1];
    if (!handler) throw new Error('Expected project-deleted event subscription');
    const revalidate = vi.mocked(appState.navigation.revalidate);
    revalidate.mockClear();

    handler({ projectId: gone.id });

    expect(store.projects.has(gone.id)).toBe(false);
    expect(store.projects.has(kept.id)).toBe(true);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // 这个窗口自己删的早已拿掉:再收到同一条什么都不做。
    handler({ projectId: gone.id });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('hides an empty detached project and mounts the same project when undo or history restores it', () => {
    const store = new ProjectManagerStore();
    const project = localProject({ id: 'detached-project', rootFolderDetached: true });
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));
    const handler = mocks.eventOn.mock.calls.find(([channel]) => channel === projectVisibilityChangedChannel)?.[1];
    if (!handler) throw new Error('Expected visibility subscription');
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    handler({ projectId: project.id, project: null });
    expect(store.projects.has(project.id)).toBe(false);
    handler({ projectId: project.id, project });
    expect(store.projects.get(project.id)?.name).toBe(project.name);
    expect(mount).toHaveBeenCalledWith(project.id);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('hands a session created in a project that is not mounted yet to its task manager once it mounts', async () => {
    const store = new ProjectManagerStore();
    const createdSession = session({ projectId: 'external-project' });
    const accepted = Promise.withResolvers<void>();
    const acceptCreatedSession = vi.fn(() => accepted.resolve());
    const ensureProjectLoaded = vi
      .spyOn(store, 'ensureProjectLoaded')
      .mockImplementation(async (projectId) => {
        store.projects.set(
          projectId,
          { mountedProject: { sessionManager: { acceptCreatedSession } } } as never
        );
      });
    const handler = mocks.eventOn.mock.calls.find(
      ([channel]) => channel === sessionCreatedChannel
    )?.[1];
    if (!handler) throw new Error('Expected conversation-created event subscription');

    handler({ session: createdSession });

    await accepted.promise;
    expect(acceptCreatedSession).toHaveBeenCalledWith(createdSession);
    expect(ensureProjectLoaded).toHaveBeenCalledWith('external-project');
  });

  it('fails loudly when an imported project is absent from the main process', async () => {
    const store = new ProjectManagerStore();

    await expect(store.ensureProjectLoaded('missing-project')).rejects.toThrow(
      'Project missing-project was not found after import'
    );
  });

  it('returns an existing project without starting creation', async () => {
    const existingProject = localProject({ id: 'existing-project' });
    mocks.inspectProjectPath.mockResolvedValueOnce({
      isDirectory: true,
      isGitRepo: true,
      existingProject,
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result).toEqual({ kind: 'existing', projectId: 'existing-project' });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(store.projects.has('optimistic-project')).toBe(false);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('fails loudly with the out-of-scope path owner before starting creation (#4855)', async () => {
    mocks.inspectProjectPath.mockResolvedValueOnce({
      isDirectory: true,
      isGitRepo: true,
      pathConflict: { id: 'ssh-row-1', workspaceProvider: 'ssh', name: 'gugu-main' },
    });
    const store = new ProjectManagerStore();

    const error = await store
      .startProjectCreation(
        { type: 'local' },
        { mode: 'pick', name: 'Project', path: '/root/gugu-main' },
        { id: 'optimistic-project' }
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProjectPathConflictError);
    expect(error).toMatchObject({
      message: expect.stringContaining('already taken by ssh project "gugu-main" (ssh-row-1)'),
    });
    expect((error as Error).message).not.toContain('/root/gugu-main');

    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(store.projects.has('optimistic-project')).toBe(false);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('creates unregistered project state before returning creating', async () => {
    let resolveCreateProject: (project: LocalProject) => void = () => {};
    mocks.createProject.mockReturnValueOnce(
      new Promise<ReturnType<typeof okProject>>((resolve) => {
        resolveCreateProject = (project) => resolve(okProject(project));
      })
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    const pendingProject = store.projects.get('optimistic-project');
    expect(pendingProject && isUnregisteredProject(pendingProject)).toBe(true);
    expect(pendingProject?.phase).toBe('registering');
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(true);
    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);

    resolveCreateProject(localProject({ id: 'optimistic-project' }));
    if (result.kind === 'creating') await result.completion;

    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('does not let a project registered at the clone parent path short-circuit creation', async () => {
    const parentProject = localProject({ id: 'parent-project', path: '/parent' });
    mocks.inspectProjectPath.mockImplementation(async ({ path }: { path: string }) => ({
      isDirectory: true,
      isGitRepo: true,
      existingProject: path === '/parent' ? parentProject : undefined,
    }));
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'clone',
        name: 'child-project',
        path: '/parent',
        repositoryUrl: 'https://github.com/acme/child-project.git',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(result.kind).toBe('creating');
    expect(store.projects.has('optimistic-project')).toBe(true);
  });

  it('does not let a project registered at the new-project parent path short-circuit creation', async () => {
    const parentProject = localProject({ id: 'parent-project', path: '/parent' });
    mocks.inspectProjectPath.mockImplementation(async ({ path }: { path: string }) => ({
      isDirectory: true,
      isGitRepo: true,
      existingProject: path === '/parent' ? parentProject : undefined,
    }));
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'child-project',
        path: '/parent',
        repositoryName: 'child-project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') void result.completion;
    expect(result.kind).toBe('creating');
    expect(store.projects.has('optimistic-project')).toBe(true);
  });

  it('persists the selected GitHub account after registering a new project', async () => {
    mocks.cloneRepository.mockResolvedValueOnce({ success: true });
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).toHaveBeenCalledWith('optimistic-project', {
      githubAccountId: 'github.com:42',
    });
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('removes its event subscriptions once on dispose', () => {
    const disposeProjectCreatedEvent = vi.fn();
    const disposeSessionCreatedEvent = vi.fn();
    mocks.eventOn
      .mockReturnValueOnce(disposeProjectCreatedEvent)
      .mockReturnValueOnce(disposeSessionCreatedEvent);
    const store = new ProjectManagerStore();

    store.dispose();
    store.dispose();

    expect(disposeProjectCreatedEvent).toHaveBeenCalledTimes(1);
    expect(disposeSessionCreatedEvent).toHaveBeenCalledTimes(1);
  });

  it('records path-access-blocked so the panel can offer permission recovery', async () => {
    // 权限挡住时 openProject 会明确报 path-access-blocked;若这里退化成通用 error,
    // 面板就只剩一句 timeout、没有任何恢复动作(gugu #3611)。
    const project = localProject();
    mocks.openProject.mockResolvedValue({
      success: false,
      error: { type: 'path-access-blocked', path: project.path },
    });
    const store = new ProjectManagerStore();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));

    await store.mountProject(project.id);

    const projectStore = store.projects.get(project.id);
    expect(projectStore?.phase).toBe('error');
    expect(projectStore?.errorCode).toBe('path-access-blocked');
    expect(projectStore?.error).toBe(project.path);
  });

  it('marks project creation as failed when the project RPC returns a typed error', async () => {
    mocks.createProject.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'not-repository',
        path: '/project',
      },
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/project' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'not-repository', path: '/project' },
      });
    }

    const project = store.projects.get('optimistic-project');
    expect(project && isUnregisteredProject(project)).toBe(true);
    if (project && isUnregisteredProject(project)) {
      expect(project.phase).toBe('error');
      expect(project.error).toBe(
        'Directory is not a git repository. Pick a folder that is one, or create a new project instead.'
      );
    }
  });

  it('marks project creation with an inspection failure message', async () => {
    mocks.createProject.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'inspect-failed',
        path: '/Volumes/Data/dev/myapp',
        message: 'Permission denied',
      },
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Project', path: '/Volumes/Data/dev/myapp' },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: {
          type: 'inspect-failed',
          path: '/Volumes/Data/dev/myapp',
          message: 'Permission denied',
        },
      });
    }

    const project = store.projects.get('optimistic-project');
    expect(project && isUnregisteredProject(project)).toBe(true);
    if (project && isUnregisteredProject(project)) {
      expect(project.phase).toBe('error');
      expect(project.error).toBe('Could not inspect directory: Permission denied');
    }
  });

  it('passes blank-directory creation independently of Git initialization', async () => {
    mocks.createProject.mockResolvedValueOnce(okProject(localProject({
      id: 'blank-project', baseRef: null,
    })));
    const store = new ProjectManagerStore();
    const result = await store.startProjectCreation(
      { type: 'local' },
      { mode: 'pick', name: 'Blank', path: '/project', createDirectory: true, allowNonGit: true },
      { id: 'blank-project' }
    );
    if (result.kind === 'creating') await result.completion;

    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      type: 'local', path: '/project', createDirectory: true, allowNonGit: true,
      initGitRepository: undefined,
    }));
    expect(mocks.patchProjectSettings).not.toHaveBeenCalled();
  });

  it('persists the default GitHub account after initializing a picked folder', async () => {
    mocks.createProject.mockResolvedValueOnce(
      okProject(localProject({ id: 'optimistic-project' }))
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        initGitRepository: true,
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    if (result.kind === 'creating') await result.completion;

    expect(mocks.patchProjectSettings).toHaveBeenCalledWith('optimistic-project', {
      githubAccountId: 'github.com:42',
    });
    expect(mocks.updateProjectSettings).not.toHaveBeenCalled();
  });

  it('deletes a newly created GitHub repository with the selected account if clone fails', async () => {
    mocks.cloneRepository.mockResolvedValueOnce({ success: false, error: 'Clone failed' });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'clone-failed', message: 'Clone failed' },
      });
    }

    expect(mocks.deleteGithubRepository).toHaveBeenCalledWith({
      owner: 'acme',
      name: 'project',
      accountId: 'github.com:42',
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('does not attempt GitHub repository rollback when repository creation fails', async () => {
    mocks.createGithubRepository.mockResolvedValueOnce({
      success: false,
      error: 'Repository creation failed',
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'new',
        name: 'Project',
        path: '/parent',
        repositoryName: 'project',
        repositoryOwner: 'acme',
        repositoryVisibility: 'private',
        githubAccountId: 'github.com:42',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'repository-create-failed', message: 'Repository creation failed' },
      });
    }

    expect(mocks.deleteGithubRepository).not.toHaveBeenCalled();
  });
});

describe('ensureMounted:挂载的唯一入口(别的机器上的项目列出不挂,用到才挂)', () => {
  it('那台机器的项目:登记时不挂;要用时线没开就等它开了再挂,同一个项目只等一份', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const store = new ProjectManagerStore();
    store.syncMachineProjects('dev-r', [localProject({ id: 'remote-p' })]);
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    expect(machineRegistry.machineOf('remote-p')).toBe('dev-r');
    expect(mount).not.toHaveBeenCalled();

    const first = store.ensureMounted('remote-p');
    const second = store.ensureMounted('remote-p');
    expect(second).toBe(first);
    setLink('dev-r', 'connecting');
    expect(mount).not.toHaveBeenCalled();
    setLink('dev-r', 'open');
    await first;
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith('remote-p');

    // 线开着:当场挂
    await store.ensureMounted('remote-p');
    expect(mount).toHaveBeenCalledTimes(2);
    machineRegistry.forgetMachine('dev-r');
  });

  it('本机项目:直接挂', async () => {
    const store = new ProjectManagerStore();
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    await store.ensureMounted('local-p');
    expect(mount).toHaveBeenCalledWith('local-p');
  });
});
