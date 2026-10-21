// #6264 会话右侧工作区的「界面这一侧」:文件页签、文件树、审阅、diff、浏览器、终端这些共用组件从这里拿
// 它们要的那几样状态(页签布局、编辑器、diff 视图、git 状态、面板开合)—— 不管会话在哪台机器上。
// 本机与别的机器上的会话都是 WorkspaceViewModel(一套工作台);数据从哪台机器来,由 workspace-backend.ts
// 按 projectId 决定。
//
// ❌ 组件里再判「是不是远端」—— 两套界面就是这么长出来的。
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import type { DiffViewStore } from '../diff-view/stores/diff-view-store';
import type { EditorViewStore } from '../editor/stores/editor-view-store';
import type { GitWorktreeStore } from '../stores/git-worktree-store';
import type { PrStore } from '../stores/pr-store';
import type { sessionTabView } from '../session-tab-registry';

/** 会话的工作目录与它的 git 状态。 */
export interface WorkspaceSurfaceWorkspace {
  readonly path: string;
  readonly gitWorktree: GitWorktreeStore;
  /** 仓库层面的读数(分支在不在远端、PR 地址);别的机器上没有 = null(那几个入口不摆)。 */
  readonly gitRepository: GitRepositoryStore | null;
}

export type WorkspacePaneLayout = ReturnType<typeof sessionTabView.createPaneLayoutStore>;

export interface WorkspaceSurface {
  readonly projectId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  /** 还没准备好(本机任务还在建工作区)= null。 */
  readonly workspace: WorkspaceSurfaceWorkspace | null;
  readonly paneLayout: WorkspacePaneLayout;
  readonly activePane: WorkspacePaneLayout['focusedPane'];
  readonly editorView: EditorViewStore;
  readonly diffView: DiffViewStore | null;
  readonly prStore: PrStore | null;
  readonly focusedRegion: 'main' | 'bottom';
  setFocusedRegion(region: 'main' | 'bottom'): void;
  readonly isChangesPanelVisible: boolean;
  /** 开一个文件(路径条下拉里点了一个文件):与文件树点开同一条路。 */
  openFile(path: string): void;
  /** 新开一条终端并开成一格。 */
  openTerminalAsTab(): Promise<void>;
  /** 浏览器起始页上推荐的本地开发服务地址。 */
  readonly previewServerUrls: readonly string[];
  /**
   * 这台机器此刻够不着(离线:「离线,上次在线 X」)—— 文件 / 审阅这几格照样在,只是说这一句;
   * 回来之后自己接上。这台电脑 = 永远 null。
   */
  readonly unreachableLabel: string | null;
  /** 这条会话是不是此刻屏幕上的那一页(编辑器据此抢焦点)。 */
  readonly isViewActive: boolean;
}

/**
 * #6264 会话在别的机器上、那台机器此刻够不着时说的那一句(「离线,上次在线 X」);这台电脑上的 = null。
 * 由别的机器那一侧装上(machine-workspace-backend.ts),❌ 在这里 import 它(那一串会拖进每个只想读文件的模块)。
 */
let reachLabel: (projectId: string) => string | null = () => null;

export function setWorkspaceReachResolver(resolve: (projectId: string) => string | null): void {
  reachLabel = resolve;
}

export function workspaceReachLabel(projectId: string): string | null {
  return reachLabel(projectId);
}
