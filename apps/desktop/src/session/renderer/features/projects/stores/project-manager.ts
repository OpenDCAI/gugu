import { revalidateScreenSessions } from '@renderer/app/screen-layout-actions';
import { err, ok, type Result } from '@gugu/session-shared';
import { makeObservable, observable, runInAction } from 'mobx';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { machineLinkState, subscribeMachineLink } from '@renderer/lib/machine-clients';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { log } from '@renderer/utils/logger';
import { projectCreatedChannel, projectDeletedChannel, projectVisibilityChangedChannel } from '@shared/core/projects/projectEvents';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { type LocalProject } from '@shared/projects';
import { splitNameWithOwner } from '@shared/repository-ref';
import type { ProjectViewSnapshot } from '@shared/view-state';
import {
  createUnmountedProject,
  createUnregisteredProject,
  isMountedProject,
  isUnmountedProject,
  isUnregisteredProject,
  type ProjectStore,
  type UnregisteredProjectPhase,
} from './project';
import type {
  ModeData,
  ProjectCreationCompletion,
  ProjectCreationError,
  ProjectType,
  StartProjectCreationOptions,
  StartProjectCreationResult,
} from './project-creation-types';
import { ProjectPathConflictError } from './project-creation-error';

export class ProjectManagerStore {
  projects = observable.map<string, ProjectStore>();
  pendingCreationIds = observable.set<string>();
  private _projectMountPromises = new Map<string, Promise<void>>();
  /** ensureMounted 在等那台机器连上的项目(同一个项目只等一份)。 */
  private _awaitingLink = new Map<string, Promise<void>>();
  private _loadPromise: Promise<void> | null = null;
  private _disposeProjectCreatedEvent: (() => void) | null = null;
  private _disposeProjectDeletedEvent: (() => void) | null = null;
  private _disposeProjectVisibilityEvent: (() => void) | null = null;
  private _disposeSessionCreatedEvent: (() => void) | null = null;

  constructor() {
    makeObservable(this, { projects: observable, pendingCreationIds: observable });

    this._disposeProjectCreatedEvent = events.on(projectCreatedChannel, ({ project }) => {
      let added = false;
      runInAction(() => {
        if (this.projects.has(project.id)) return;
        this.projects.set(project.id, createUnmountedProject(project, 'idle'));
        added = true;
      });
      if (added) {
        void this.mountProject(project.id).catch((error: unknown) => {
          log.error('Failed to mount externally created project', { projectId: project.id, error });
        });
      }
    });
    // 项目在它那台机器上没了(那台自己的窗口删的、别的电脑撤销「接进来」时删的,#7341):这边跟着去掉。
    // 这个窗口自己删的早就乐观地拿掉了,这里找不到就什么都不做。
    this._disposeProjectDeletedEvent = events.on(projectDeletedChannel, ({ projectId }) => {
      const store = this.projects.get(projectId);
      if (!store) return;
      runInAction(() => {
        store.mountedProject?.dispose();
        this.projects.delete(projectId);
      });
      appState.navigation.revalidate();
    });
    this._disposeProjectVisibilityEvent = events.on(projectVisibilityChangedChannel, ({ projectId, project }) => {
      if (project) {
        runInAction(() => {
          if (!this.projects.has(projectId)) this.projects.set(projectId, createUnmountedProject(project, 'idle'));
        });
        void this.mountProject(projectId).catch((error: unknown) => {
          log.error('Failed to mount restored project', { projectId, error });
        });
      } else {
        const store = this.projects.get(projectId);
        runInAction(() => {
          store?.mountedProject?.dispose();
          this.projects.delete(projectId);
        });
        appState.navigation.revalidate();
      }
    });
    // 会话建在一个还没挂载的项目里:先挂载项目(它读回来的列表里就有这一条),再交给项目的 sessionManager。
    this._disposeSessionCreatedEvent = events.on(sessionCreatedChannel, ({ session }) => {
      const project = this.projects.get(session.projectId);
      if (project && isMountedProject(project)) return;
      void this.ensureProjectLoaded(session.projectId)
        .then(() => {
          const sessionManager = this.projects.get(session.projectId)?.mountedProject?.sessionManager;
          if (!sessionManager) {
            throw new Error(`Project ${session.projectId} did not mount for session ${session.id}`);
          }
          sessionManager.acceptCreatedSession(session);
        })
        .catch((error: unknown) => {
          log.error('Failed to attach externally created session', {
            projectId: session.projectId,
            sessionId: session.id,
            error,
          });
        });
    });
  }

  dispose(): void {
    this._disposeProjectCreatedEvent?.();
    this._disposeProjectCreatedEvent = null;
    this._disposeProjectDeletedEvent?.();
    this._disposeProjectDeletedEvent = null;
    this._disposeProjectVisibilityEvent?.();
    this._disposeProjectVisibilityEvent = null;
    this._disposeSessionCreatedEvent?.();
    this._disposeSessionCreatedEvent = null;
  }

  load(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._doLoad();
    }
    return this._loadPromise;
  }

  async ensureProjectLoaded(projectId: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      const project = (await rpcOn(machineRegistry.machineOf(projectId)).projects.getProjects()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Project ${projectId} was not found after import`);
      runInAction(() => {
        if (!this.projects.has(projectId)) {
          this.projects.set(projectId, createUnmountedProject(project, 'idle'));
        }
      });
    }
    await this.mountProject(projectId);
  }

  private async _doLoad(): Promise<void> {
    const rawProjects = await rpc.projects.getProjects();
    const toMount: string[] = [];
    runInAction(() => {
      for (const p of rawProjects) {
        if (this.projects.has(p.id)) continue;
        this.projects.set(p.id, createUnmountedProject(p, 'idle'));
        toMount.push(p.id);
      }
    });
    // 首帧不等挂载(gugu #2318):两个启动入口都拿 load() 当渲染闸门,清单入 store 即返回,
    // 挂载在后台继续;侧栏/项目页按 unmounted/bootstrapping 渐进就绪,视图本就
    // 以 kind!=='ready' 守卫非就绪态。mountProject 各自兜错,allSettled 语义不变。
    void Promise.allSettled(toMount.map((id) => this.mountProject(id)));
  }

  async createProject(
    projectType: ProjectType,
    data: ModeData,
    id?: string
  ): Promise<string | undefined> {
    const result = await this.startProjectCreation(projectType, data, { id });
    if (result.kind === 'existing') return result.projectId;

    const completion = await result.completion;
    return completion.success ? result.projectId : undefined;
  }

  async startProjectCreation(
    projectType: ProjectType,
    data: ModeData,
    options: StartProjectCreationOptions = {}
  ): Promise<StartProjectCreationResult> {
    const projectId = options.id ?? crypto.randomUUID();
    // #6264 在别的机器上建:先把这个 id 记到那台机器名下,之后的挂载、任务调用才走得对。
    const machine = projectType.machine ?? null;
    if (machine) machineRegistry.register(machine, [projectId]);
    const targetPath = data.mode === 'pick' ? data.path : `${data.path}/${data.name}`;
    const inspection = await rpcOn(machine).projects.inspectProjectPath({ type: 'local', path: targetPath });
    if (inspection.existingProject) {
      if (machine) machineRegistry.register(machine, [inspection.existingProject.id]);
      if (inspection.existingProject.rootFolderDetached) {
        const attached = await rpcOn(machine).projects.attachProjectFolder(inspection.existingProject.id, targetPath);
        if (!attached.success) throw new Error(attached.error.message);
        await this.ensureProjectLoaded(inspection.existingProject.id);
      }
      return { kind: 'existing', projectId: inspection.existingProject.id };
    }
    if (inspection.pathConflict) {
      throw new ProjectPathConflictError(inspection.pathConflict);
    }

    runInAction(() => {
      this.pendingCreationIds.add(projectId);
      this.projects.set(
        projectId,
        createUnregisteredProject(projectId, data.name, initialCreationPhase(data.mode), data.mode)
      );
    });

    const completion = this._doCreateProject(projectType, data, projectId, targetPath).finally(
      () => {
        runInAction(() => this.pendingCreationIds.delete(projectId));
      }
    );

    return { kind: 'creating', projectId, completion };
  }

  private async _doCreateProject(
    projectType: ProjectType,
    data: ModeData,
    projectId: string,
    targetPath: string
  ): Promise<ProjectCreationCompletion> {
    const rpc = rpcOn(projectType.machine ?? null);

    let result: ProjectCreationCompletion;
    try {
      switch (data.mode) {
        case 'pick': {
          const projectResult = await rpc.projects.createProject({
            type: 'local',
            id: projectId,
            path: targetPath,
            name: data.name,
            createDirectory: data.createDirectory,
            initGitRepository: data.initGitRepository,
            allowNonGit: data.allowNonGit,
          });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          const project = projectResult.data;
          if (data.initGitRepository) {
            await this._saveInitialGitHubAccountSetting(project.id, data.githubAccountId);
          }
          this._setAndOpenProject(projectId, project);
          result = ok();
          break;
        }

        case 'clone': {
          const cloneResult = await rpc.projectSetup.cloneRepository(data.repositoryUrl, targetPath);
          if (!cloneResult.success) {
            result = err({
              type: 'clone-failed',
              message: cloneResult.error?.trim() || 'Clone failed',
            });
            break;
          }

          this._updatePhase(projectId, 'registering');
          const projectResult = await rpc.projects.createProject({
            type: 'local',
            id: projectId,
            path: targetPath,
            name: data.name,
          });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          this._setAndOpenProject(projectId, projectResult.data);
          result = ok();
          break;
        }

        case 'new': {
          const repoResult = await rpc.github.createRepository({
            name: data.repositoryName,
            owner: data.repositoryOwner,
            isPrivate: data.repositoryVisibility === 'private',
            accountId: data.githubAccountId ?? undefined,
          });
          if (!repoResult.success) {
            result = err({
              type: 'repository-create-failed',
              message: repoResult.error?.trim() || 'Repository creation failed',
            });
            break;
          }
          if (!repoResult.nameWithOwner || !repoResult.cloneUrl) {
            result = err({
              type: 'repository-response-incomplete',
              message: 'Repository creation response was incomplete',
            });
            break;
          }

          const projectResult = await this._cloneInitializeAndCreateGitHubProject({
            projectType,
            projectId,
            targetPath,
            name: data.name,
            cloneUrl: repoResult.cloneUrl,
            repositoryNameWithOwner: repoResult.nameWithOwner,
            githubAccountId: data.githubAccountId,
          });
          if (!projectResult.success) {
            result = err(projectResult.error);
            break;
          }

          const project = projectResult.data;
          await this._saveInitialGitHubAccountSetting(project.id, data.githubAccountId);
          this._setAndOpenProject(projectId, project);
          result = ok();
          break;
        }
      }
    } catch (error) {
      this._markUnexpectedCreationError(projectId, error);
      throw error;
    }

    if (!result.success) this._markCreationError(projectId, result.error);
    return result;
  }

  /**
   * 要用这个项目的会话了(会话页要画它、在它的一行上动手):挂上它。**挂载的唯一入口** —— 别的机器上的项目列出时
   * 不挂(行来自会话目录,见 sidebar-store),只在这里挂;那台机器此刻没连上就等它连上再挂。
   */
  ensureMounted(projectId: string): Promise<void> {
    const machine = machineRegistry.machineOf(projectId);
    if (!machine || machineLinkState(machine) === 'open') return this.mountProject(projectId);
    const waiting = this._awaitingLink.get(projectId);
    if (waiting) return waiting;
    const promise = new Promise<void>((resolve, reject) => {
      const off = subscribeMachineLink(machine, () => {
        if (machineLinkState(machine) !== 'open') return;
        off();
        this._awaitingLink.delete(projectId);
        this.mountProject(projectId).then(resolve, reject);
      });
    });
    this._awaitingLink.set(projectId, promise);
    return promise;
  }

  mountProject(projectId: string): Promise<void> {
    const inFlight = this._projectMountPromises.get(projectId);
    if (inFlight) return inFlight;

    const project = this.projects.get(projectId);
    if (!project || !isUnmountedProject(project)) return Promise.resolve();
    // #6264 别的机器上的项目:那台机器连着才挂(连上时 machines 那边会再调一次),❌ 离线时挂成一个错误态。
    const machine = machineRegistry.machineOf(projectId);
    if (machine && machineLinkState(machine) !== 'open') return Promise.resolve();

    runInAction(() => {
      project.phase = 'opening';
      project.error = undefined;
      project.errorCode = undefined;
    });

    const promise = Promise.all([
      rpc.projects.openProject(projectId),
      viewStateCache.get(`project:${projectId}`),
    ])
      .then(async ([openResult, savedSnapshot]) => {
        if (!openResult.success) {
          runInAction(() => {
            const current = this.projects.get(projectId);
            if (current && isUnmountedProject(current)) {
              current.phase = 'error';
              if (openResult.error.type === 'path-not-found') {
                current.error = openResult.error.path;
                current.errorCode = 'path-not-found';
              } else if (openResult.error.type === 'path-access-blocked') {
                current.error = openResult.error.path;
                current.errorCode = 'path-access-blocked';
              } else {
                current.error = openResult.error.message;
                current.errorCode = undefined;
              }
            }
          });
          return;
        }
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            // Patch repositoryWorkspaceId from the main process response so the
            // mounted project data is up-to-date (fixes stale null after creation).
            const projectData = current.data;
            projectData.baseRef = openResult.data.baseRef;
            if (openResult.data.repositoryWorkspaceId && projectData) {
              projectData.repositoryWorkspaceId = openResult.data.repositoryWorkspaceId;
            }
            current.transitionToMounted(
              projectData,
              savedSnapshot as ProjectViewSnapshot | undefined
            );
          }
        });
        // Load the task list before provisioning so the tasks map is populated.
        const sessionManager = this.projects.get(projectId)?.mountedProject?.sessionManager;
        if (sessionManager) {
          await sessionManager.loadSessions();
          const nav = appState.navigation;
          // 任务列表到位之后补跑一次路由校验。守卫判的就是这份列表,而它**第一次**跑是在冷启动
          // 恢复快照那一刻 —— 那时项目还没挂载、sessionManager 还不存在,守卫只能一律放行,之后再也
          // 不跑。少了这一次,恢复到一个已归档(或已消失)的任务就会原样停在那儿;更糟的是下面这段
          // 会把它 provision 起来,等于把一项归档任务反向复活。
          //
          // 顺序要紧:先校验、后 provision。反过来就是先复活再问该不该去。
          nav.revalidate();
          // 这屏上摆着的会话块同一刻核一次(重启读回来的摆法里,可能有已经删掉 / 归档的)。
          revalidateScreenSessions(projectId, (sessionId) => {
            const session = sessionManager.sessions.get(sessionId);
            return session !== undefined && !session.data.archivedAt;
          });
          const navParams = nav.viewParamsStore['session'] as
            | { projectId?: string; sessionId?: string }
            | undefined;
          const navSessionId =
            nav.currentViewId === 'session' && navParams?.projectId === projectId
              ? navParams.sessionId
              : undefined;
          if (navSessionId) {
            sessionManager.provisionSession(navSessionId).catch(() => {});
          }
        }
      })
      .catch((err: unknown) => {
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            current.phase = 'error';
            current.error = err instanceof Error ? err.message : String(err);
            current.errorCode = undefined;
          }
        });
        throw err;
      })
      .finally(() => {
        this._projectMountPromises.delete(projectId);
      });

    this._projectMountPromises.set(projectId, promise);
    return promise;
  }

  /**
   * #6264 一台别的机器上的项目清单(那台机器连上时 / 离线时取上次记下的):并入同一张项目表,
   * 与本机项目同一套界面(照 Zed:机器是项目的属性)。**只登记,❌ 挂**:侧栏的行来自会话目录,
   * 要用到某个项目时才由 ensureMounted 挂上。清单里没有了的那台机器的项目拿掉(在那台机器上删掉的)。
   */
  syncMachineProjects(deviceId: string, projects: readonly LocalProject[]): void {
    machineRegistry.register(
      deviceId,
      projects.map((project) => project.id)
    );
    const keep = new Set(projects.map((project) => project.id));
    runInAction(() => {
      for (const project of projects) {
        if (!this.projects.has(project.id)) this.projects.set(project.id, createUnmountedProject(project, 'idle'));
      }
      for (const [id, store] of [...this.projects]) {
        if (keep.has(id) || this.pendingCreationIds.has(id)) continue;
        if (machineRegistry.machineOf(id) !== deviceId) continue;
        store.mountedProject?.dispose();
        this.projects.delete(id);
      }
    });
    // 那台机器的清单(连上读到的 / 账号上那份)并进来了:停在它的某个项目 / 会话上「还不知道」的那一页按此刻的重判。
    appState.navigation.revalidate();
  }

  /** 那台机器又连上了:已挂着的项目重读任务列表(断开那段时间的推送收不到)。 */
  refreshMachineProjects(deviceId: string): void {
    for (const [id, store] of this.projects) {
      if (machineRegistry.machineOf(id) !== deviceId) continue;
      const sessionManager = store.mountedProject?.sessionManager;
      if (sessionManager) {
        void sessionManager.resync().catch((error: unknown) =>
          log.warn('Failed to resync a project on another machine', { projectId: id, deviceId, error })
        );
      }
    }
  }

  /** 那台机器被移除 / 换了账号:它的项目从表里拿掉。 */
  dropMachine(deviceId: string): void {
    runInAction(() => {
      for (const [id, store] of [...this.projects]) {
        if (machineRegistry.machineOf(id) !== deviceId) continue;
        store.mountedProject?.dispose();
        this.projects.delete(id);
      }
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const snapshot = this.projects.get(projectId);
    runInAction(() => {
      this.projects.delete(projectId);
    });
    appState.navigation.revalidate();
    try {
      await rpc.projects.deleteProject(projectId);
    } catch (err) {
      runInAction(() => {
        if (snapshot) this.projects.set(projectId, snapshot);
      });
      throw err;
    }
  }

  removeUnregisteredProject(projectId: string): void {
    runInAction(() => {
      const store = this.projects.get(projectId);
      if (store && isUnregisteredProject(store)) {
        this.projects.delete(projectId);
      }
    });
  }

  private _setAndOpenProject(id: string, project: LocalProject): void {
    runInAction(() => {
      const current = this.projects.get(id);
      if (current) {
        current.transitionToUnmounted(project, 'opening');
      } else {
        this.projects.set(id, createUnmountedProject(project, 'opening'));
      }
    });
    void this.mountProject(id);
  }

  private async _saveInitialGitHubAccountSetting(
    projectId: string,
    githubAccountId?: string
  ): Promise<void> {
    if (githubAccountId === undefined) return;

    const result = await rpc.projects.patchProjectSettings(projectId, { githubAccountId });
    if (!result.success) {
      log.error('Failed to save initial GitHub account for project', {
        projectId,
        error: result.error,
      });
    }
  }

  private async _rollbackCreatedGitHubRepository(
    nameWithOwner: string,
    githubAccountId?: string
  ): Promise<void> {
    try {
      const { owner, repo } = splitNameWithOwner(nameWithOwner);
      const result = await rpc.github.deleteRepository({
        owner,
        name: repo,
        accountId: githubAccountId ?? undefined,
      });
      if (!result.success) {
        log.error('Failed to delete GitHub repository after project creation failure', {
          nameWithOwner,
          error: result.error,
        });
      }
    } catch (error) {
      log.error('Failed to delete GitHub repository after project creation failure', {
        nameWithOwner,
        error,
      });
    }
  }

  private async _cloneInitializeAndCreateGitHubProject(opts: {
    projectType: ProjectType;
    projectId: string;
    targetPath: string;
    name: string;
    cloneUrl: string;
    repositoryNameWithOwner: string;
    githubAccountId?: string;
  }): Promise<Result<LocalProject, ProjectCreationError>> {
    const rpc = rpcOn(opts.projectType.machine ?? null);
    let result: Result<LocalProject, ProjectCreationError>;
    try {
      this._updatePhase(opts.projectId, 'cloning');
      const cloneResult = await rpc.projectSetup.cloneRepository(opts.cloneUrl, opts.targetPath);
      if (!cloneResult.success) {
        result = err({
          type: 'clone-failed',
          message: cloneResult.error?.trim() || 'Clone failed',
        });
      } else {
        const initResult = await rpc.projectSetup.initializeRepository({
          targetPath: opts.targetPath,
          name: opts.name,
        });
        if (!initResult.success) {
          result = err({
            type: 'initialize-failed',
            message: initResult.error?.trim() || 'Project initialization failed',
          });
        } else {
          this._updatePhase(opts.projectId, 'registering');
          result = await rpc.projects.createProject({
            type: 'local',
            id: opts.projectId,
            path: opts.targetPath,
            name: opts.name,
          });
        }
      }
    } catch (error) {
      await this._rollbackCreatedGitHubRepository(
        opts.repositoryNameWithOwner,
        opts.githubAccountId
      );
      throw error;
    }

    if (!result.success) {
      await this._rollbackCreatedGitHubRepository(
        opts.repositoryNameWithOwner,
        opts.githubAccountId
      );
    }
    return result;
  }

  private _updatePhase(id: string, phase: UnregisteredProjectPhase): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) store.phase = phase;
    });
  }

  private _markCreationError(id: string, error: ProjectCreationError): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error =
          error.type === 'not-repository'
            ? 'Directory is not a git repository. Pick a folder that is one, or create a new project instead.'
            : error.type === 'inspect-failed'
              ? `Could not inspect directory: ${error.message}`
              : error.message;
      }
    });
  }

  private _markUnexpectedCreationError(id: string, error: unknown): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error = error instanceof Error ? error.message : String(error);
      }
    });
  }
}

function initialCreationPhase(mode: ModeData['mode']): UnregisteredProjectPhase {
  switch (mode) {
    case 'pick':
      return 'registering';
    case 'clone':
      return 'cloning';
    case 'new':
      return 'creating-repo';
  }
}
