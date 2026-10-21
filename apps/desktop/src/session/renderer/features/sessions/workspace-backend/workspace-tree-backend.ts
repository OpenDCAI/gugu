// 文件树里超出 `rpc.workspace` 的那几个动作 —— 照 VS Code 资源管理器(新建文件 / 新建文件夹 / 重命名 / 删除 /
// 从访达拖进来 / 上传 / 下载)。界面只有一棵树(editor-file-tree.tsx),这里是它背后按机器不同的那一半:
// 这台电脑上的文件直接动;别的机器上的经那台机器的设备接口动(删除先放回收站、传输有真实进度)。
import type { FilesStore } from '../editor/stores/files-store';

/** 树所在的那份工作区。 */
export type WorkspaceTreeScope = {
  projectId: string;
  workspaceId: string;
  /** 工作区根目录(那台机器上的绝对路径)。 */
  rootPath: string;
  files: FilesStore | null;
};

export type WorkspaceTreeEntry = {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
};

/**
 * 失败的种类:`exists` 同名已有、`invalid_name` 名字不行、`trash_unavailable` 那台机器放不进回收站
 * (界面据此再问一次「永久删除」)、`failed` 其余(`message` 是已经写好的人话)。
 */
export type WorkspaceTreeFailure = {
  code: 'exists' | 'invalid_name' | 'trash_unavailable' | 'failed';
  message: string;
};

export type WorkspaceTreeResult<T> = { ok: true; value: T } | { ok: false; failure: WorkspaceTreeFailure };

/** 一件正在传的东西(真实进度:已完成 / 总共 · 速度,能取消)。 */
export type WorkspaceTransferRow = {
  readonly id: string;
  readonly kind: 'upload' | 'download';
  readonly name: string;
  readonly done: number;
  readonly total: number;
  readonly bytesPerSecond: number;
  cancel(): void;
};

export interface WorkspaceTreeBackend {
  /**
   * 删除怎么做:`permanent` = 问一句就删(这台电脑,与此前一致);`trash` = 先放进那台机器的回收站,
   * 放不进去再问一次「永久删除」(照 VS Code:远端一律只有永久删除是 vscode#108731 里用户在抱怨的)。
   */
  readonly deleteMode: 'permanent' | 'trash';
  /** 「在访达中显示」只对这台电脑上的文件有意义。 */
  readonly canReveal: boolean;
  create(
    scope: WorkspaceTreeScope,
    dir: string,
    name: string,
    kind: 'file' | 'folder'
  ): Promise<WorkspaceTreeResult<{ path: string }>>;
  rename(scope: WorkspaceTreeScope, path: string, name: string): Promise<WorkspaceTreeResult<{ path: string }>>;
  remove(
    scope: WorkspaceTreeScope,
    entry: WorkspaceTreeEntry,
    mode: 'trash' | 'permanent'
  ): Promise<WorkspaceTreeResult<{ mode: 'trash' | 'permanent' }>>;
  /**
   * 从访达 / 资源管理器拖进来的东西放进 `dir`。拖放数据必须在事件这一拍里读完(浏览器事后就收回),
   * 所以这里同步取、异步传;结束时自己说一句(成功 / 替换吗 / 失败)。
   */
  importDropped(scope: WorkspaceTreeScope, dir: string, dataTransfer: DataTransfer): Promise<void>;
  /** 「上传…」选中的文件(只有别的机器上有:这台电脑上的文件本来就在这里)。 */
  uploadFiles?(scope: WorkspaceTreeScope, dir: string, files: File[]): Promise<void>;
  /** 「下载…」到这台电脑(只有别的机器上有)。 */
  download?(scope: WorkspaceTreeScope, entry: WorkspaceTreeEntry): Promise<void>;
  /** 正在进行的传输(可观察)。 */
  transfers?(scope: WorkspaceTreeScope): readonly WorkspaceTransferRow[];
  /** 这台机器的文件监视名额用完了:照 VS Code「Unable to watch for file changes」如实说一句。 */
  watchLimited?(scope: WorkspaceTreeScope): boolean;
  /** 有目录只列了前 N 项(那台机器一层最多给这么多):返回 N,树底下说一句;都列全了 = null。 */
  truncated?(scope: WorkspaceTreeScope): number | null;
}
