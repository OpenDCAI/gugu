/**
 * 项目挂的文件夹(product spec,#7341)。
 *
 * 一个项目 = 它的根目录 + 任意多个挂上来的文件夹(同一台机器上的 worktree、一起改的相关仓库……)。
 * 一个文件夹只属于一个项目:同一个绝对路径在这台机器上只有一条工作区记录。
 * 会话从哪个文件夹开工,就把那个文件夹的 workspaceId 放进 createSession 的 workspaceConfig。
 */
export type ProjectFolderKind = 'root' | 'attached';

export type ProjectFolder = {
  /** 这个文件夹的工作区记录 id;新建会话时作为 repository-instance 的 workspaceId。 */
  workspaceId: string;
  projectId: string;
  kind: ProjectFolderKind;
  /** 绝对路径(在项目所在的那台机器上)。 */
  path: string;
  /** 那里当前检出的 git 分支;不是 git 仓库或读不到时为 null。 */
  branch: string | null;
  /** 从这个文件夹开工、还没归档的会话 id(渲染层据此算「几个在这儿跑」)。 */
  sessionIds: string[];
  /** 挂上的时间(ISO);根目录为 null。 */
  attachedAt: string | null;
};

export type ProjectFolderNotFound = { type: 'not-found'; message: string };

export type AttachProjectFolderError =
  | ProjectFolderNotFound
  | { type: 'not-a-directory'; message: string }
  /** 这个文件夹本身就是某个项目的根目录(可能就是本项目)。 */
  | { type: 'is-project-root'; projectId: string; projectName: string; message: string }
  /** 这个文件夹已经挂在别的项目下。 */
  | { type: 'belongs-to-other-project'; projectId: string; projectName: string; message: string };

export type DetachProjectFolderError = ProjectFolderNotFound;
