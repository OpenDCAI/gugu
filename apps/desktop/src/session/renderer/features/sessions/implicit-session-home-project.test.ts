import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeProject = {
  id: string;
  name: string;
  state: 'unregistered' | 'unmounted' | 'mounted';
  mountedProject: object | null;
  error?: string;
};

function createManager() {
  const projects = new Map<string, FakeProject>();
  const pendingCreationIds = new Set<string>();

  return {
    projects,
    pendingCreationIds,
    load: vi.fn(async () => undefined),
    createProject: vi.fn(
      async (
        _projectType: unknown,
        _data: unknown,
        _projectId?: string
      ): Promise<string | undefined> => undefined
    ),
    mountProject: vi.fn(async (_projectId: string) => undefined),
    removeUnregisteredProject: vi.fn((projectId: string) => {
      projects.delete(projectId);
    }),
  };
}

type FakeManager = ReturnType<typeof createManager>;

const mocks = vi.hoisted(() => ({
  manager: null as unknown,
  getSessionHomeDir: vi.fn(),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => mocks.manager,
  asMounted: (project: { mountedProject?: object | null } | undefined) =>
    project?.mountedProject ?? undefined,
}));

vi.mock('@renderer/features/projects/stores/project', () => ({
  isUnregisteredProject: (project: { state?: string }) => project.state === 'unregistered',
}));

vi.mock('@renderer/lib/ipc', () => {
  const mod = {
  rpc: {
    app: {
      getSessionHomeDir: mocks.getSessionHomeDir,
    },
  },
  };
  // #6264 一套工作台:按机器路由的那几个口,替身里都落到本机这一份。
  return {
    rpcOn: () => mod.rpc,
    onMachineEvent: () => () => {},
    ...mod,
  };
});

const { ensureImplicitSessionHomeProjectId, ImplicitSessionHomeProjectError } =
  await import('./implicit-session-home-project');
const { IMPLICIT_SESSION_HOME_PROJECT_ID, IMPLICIT_SESSION_HOME_PROJECT_NAME } =
  await import('./session-home-project-constants');

function project(state: FakeProject['state'], overrides: Partial<FakeProject> = {}): FakeProject {
  return {
    id: IMPLICIT_SESSION_HOME_PROJECT_ID,
    name: IMPLICIT_SESSION_HOME_PROJECT_NAME,
    state,
    mountedProject: state === 'mounted' ? {} : null,
    ...overrides,
  };
}

describe('ensureImplicitSessionHomeProjectId', () => {
  let manager: FakeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createManager();
    mocks.manager = manager;
    mocks.getSessionHomeDir.mockResolvedValue('/app-data/task-home');
  });

  it('reuses an already mounted fixed-id project without creating another one', async () => {
    manager.projects.set(IMPLICIT_SESSION_HOME_PROJECT_ID, project('mounted'));

    await expect(ensureImplicitSessionHomeProjectId()).resolves.toBe(IMPLICIT_SESSION_HOME_PROJECT_ID);

    expect(manager.load).toHaveBeenCalledOnce();
    expect(manager.mountProject).toHaveBeenCalledWith(IMPLICIT_SESSION_HOME_PROJECT_ID);
    expect(manager.createProject).not.toHaveBeenCalled();
    expect(mocks.getSessionHomeDir).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent creation and resolves only after the project mounts', async () => {
    let releaseCreation: (() => void) | undefined;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const creating = Promise.withResolvers<void>();

    manager.createProject.mockImplementationOnce(async () => {
      creating.resolve();
      await creationGate;
      manager.projects.set(IMPLICIT_SESSION_HOME_PROJECT_ID, project('unmounted'));
      return IMPLICIT_SESSION_HOME_PROJECT_ID;
    });
    manager.mountProject.mockImplementationOnce(async (projectId: string) => {
      const existing = manager.projects.get(projectId);
      if (!existing) return;
      existing.state = 'mounted';
      existing.mountedProject = {};
    });

    const first = ensureImplicitSessionHomeProjectId();
    const second = ensureImplicitSessionHomeProjectId();

    await creating.promise;
    expect(manager.createProject).toHaveBeenCalledOnce();
    expect(mocks.getSessionHomeDir).toHaveBeenCalledOnce();
    releaseCreation?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      IMPLICIT_SESSION_HOME_PROJECT_ID,
      IMPLICIT_SESSION_HOME_PROJECT_ID,
    ]);
    expect(manager.createProject).toHaveBeenCalledOnce();
    expect(manager.createProject).toHaveBeenCalledWith(
      { type: 'local' },
      {
        mode: 'pick',
        path: '/app-data/task-home',
        name: IMPLICIT_SESSION_HOME_PROJECT_NAME,
        initGitRepository: false,
        allowNonGit: true,
      },
      IMPLICIT_SESSION_HOME_PROJECT_ID
    );
    expect(manager.mountProject).toHaveBeenCalledOnce();
  });

  it('cleans up a failed unregistered project so a later call can retry', async () => {
    manager.createProject
      .mockImplementationOnce(async () => {
        manager.projects.set(IMPLICIT_SESSION_HOME_PROJECT_ID, project('unregistered'));
        return undefined;
      })
      .mockImplementationOnce(async () => {
        manager.projects.set(IMPLICIT_SESSION_HOME_PROJECT_ID, project('unmounted'));
        return IMPLICIT_SESSION_HOME_PROJECT_ID;
      });
    manager.mountProject.mockImplementationOnce(async (projectId: string) => {
      const existing = manager.projects.get(projectId);
      if (!existing) return;
      existing.state = 'mounted';
      existing.mountedProject = {};
    });

    // 失败以稳定语义码抛出，文案在渲染边界才映射 —— 这里断言码，不断言任何一种语言的句子。
    await expect(ensureImplicitSessionHomeProjectId()).rejects.toMatchObject(
      expect.objectContaining({ reason: 'create-failed' })
    );
    expect(manager.removeUnregisteredProject).toHaveBeenCalledWith(IMPLICIT_SESSION_HOME_PROJECT_ID);
    expect(manager.projects.has(IMPLICIT_SESSION_HOME_PROJECT_ID)).toBe(false);

    await expect(ensureImplicitSessionHomeProjectId()).resolves.toBe(IMPLICIT_SESSION_HOME_PROJECT_ID);
    expect(manager.createProject).toHaveBeenCalledTimes(2);
  });

  it('rejects when mount resolves without transitioning the project to mounted', async () => {
    manager.projects.set(
      IMPLICIT_SESSION_HOME_PROJECT_ID,
      project('unmounted', { error: 'open failed' })
    );

    // 底层 detail 是原始诊断，必须原样带出，不被改写也不进翻译目录。
    const failure = await ensureImplicitSessionHomeProjectId().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImplicitSessionHomeProjectError);
    expect(failure).toMatchObject({ reason: 'open-failed', detail: 'open failed' });

    expect(manager.mountProject).toHaveBeenCalledWith(IMPLICIT_SESSION_HOME_PROJECT_ID);
    expect(manager.createProject).not.toHaveBeenCalled();
  });
});
