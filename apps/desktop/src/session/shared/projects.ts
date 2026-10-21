import type { Result } from '@gugu/session-shared';

export type ProjectPathStatus = {
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: { type: 'inspect-failed'; path: string; message: string };
};

export type LocalProject = {
  type: 'local';
  id: string;
  name: string;
  path: string;
  // gugu #2358: null = 项目目录不是 git 仓库(远程非 git 放行,product spec)。git 项目
  // (含 unborn 仓)永远有非空 baseRef,所以 null 唯一标识非 git —— 不必加数据库列。
  baseRef: string | null;
  /** The workspace ID of this project's repository-root workspace. Set on first mount. */
  repositoryWorkspaceId: string | null;
  /** Directory membership only; the original workspace and sessions remain available. */
  rootFolderDetached?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Project = LocalProject;

/** The project row that owns a path in the database's global path index. */
export type ProjectPathConflict = {
  id: string;
  name: string;
  /** 'ssh' = 已下架的 SSH 远程项目(#6264)仍占着全局路径索引里的那一行。 */
  workspaceProvider: 'local' | 'ssh';
};

export type CreateLocalProjectParams = {
  type: 'local';
  id?: string;
  path: string;
  name: string;
  initGitRepository?: boolean;
  /** Create the directory itself without requiring Git initialization. */
  createDirectory?: boolean;
  /** 「使用现有文件夹」:所选目录本身就是项目,不是 git 仓库也放行(与远程项目同口径,#2358),❌ 替用户 git init。 */
  allowNonGit?: boolean;
};

export type CreateProjectParams = CreateLocalProjectParams;

export type CreateProjectError =
  | { type: 'invalid-directory'; path: string; message: string }
  | { type: 'not-repository'; path: string }
  | { type: 'inspect-failed'; path: string; message: string }
  | { type: 'init-failed'; path: string; message: string }
  | { type: 'open-repository-failed'; path: string; message: string };

export type CreateProjectResult = Result<Project, CreateProjectError>;

export type InspectLocalProjectPathParams = {
  type: 'local';
  path: string;
};

export type InspectProjectPathParams = InspectLocalProjectPathParams;

export type ProjectPathInspection = ProjectPathStatus & {
  existingProject?: Project;
  /** A provider-scoped lookup missed this row, but the global path index will reject insertion. */
  pathConflict?: ProjectPathConflict;
};

export type OpenProjectError =
  | { type: 'path-not-found'; path: string }
  /**
   * 目录存在,但读取它在预算内没有返回 —— macOS 上典型是 TCC 权限弹窗尚未被应答(#3611)。
   * 与 timeout 分开是因为用户要做的事完全不同:一个是去授权,一个是等或重试。
   */
  | { type: 'path-access-blocked'; path: string }
  | { type: 'error'; message: string };

export type OpenProjectSuccess = {
  repositoryWorkspaceId: string | null;
  /** Effective Git capability at mount time, which can differ from an old row. */
  baseRef: string | null;
};

export type UpdateProjectSettingsError =
  | { type: 'project-not-found' }
  | { type: 'invalid-settings' }
  | { type: 'invalid-worktree-directory' }
  | { type: 'write-config-failed'; message: string }
  | { type: 'error' };

export type ProjectRemoteState = {
  hasRemote: boolean;
  selectedRemoteUrl: string | null;
};
