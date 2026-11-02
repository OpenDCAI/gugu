import { reaction, runInAction, type IReactionDisposer } from 'mobx';
import { EDITOR_HARD_MAX_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind, isMonacoBackedKind } from '@renderer/lib/editor/fileKind';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath, EXTERNAL_MODEL_ROOT } from '@renderer/lib/monaco/monacoModelPath';
import { getMonacoLanguageId } from '@renderer/utils/diffUtils';
import type { FileTabResource } from './file-tab-resource';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

/**
 * Context needed to register Monaco models for a file.
 * Mirrors the fields available in SessionTabContext.
 */
export interface FileModelContext {
  projectId: string;
  workspaceId: string;
  modelRootPath: string;
}

type ResourceSet = Set<FileTabResource>;

type EntryState =
  | { status: 'pending'; resources: ResourceSet }
  | { status: 'image'; dataUrl: string; resources: ResourceSet }
  | { status: 'too-large'; totalSize: number; resources: ResourceSet }
  | { status: 'error'; resources: ResourceSet }
  | { status: 'binary'; resources: ResourceSet }
  | { status: 'ready'; resources: ResourceSet };

/**
 * Per-workspace ref-counted manager for Monaco model lifecycles.
 *
 * Replaces the union-of-paths reaction that previously lived in EditorViewStore.
 *
 * `acquire(path, resource, ctx)`:
 *   - First caller: triggers async Monaco model registration.
 *   - Subsequent callers: immediately notifies the new resource with the
 *     current registration state (so multi-pane same-file tabs get their UI updated).
 *
 * `release(path, resource)`:
 *   - Removes the resource from the notification set.
 *   - When no resources remain, unregisters Monaco models.
 *
 * Save/conflict/restore remain in EditorViewStore (not tab-owned).
 */
export class FileModelManager {
  private readonly _entries = new Map<string, EntryState>();
  private readonly _externalPaths = new Map<string, boolean>();
  /** 打开着的文件所在目录的监听租约(见 Workspace.watchDirectory):第一个页签打开时要,最后一个关掉时撤。 */
  private readonly _directoryWatches = new Map<string, Promise<string | null>>();
  /** 图片读一次字节就画:盘上这个文件变了(modelRegistry.diskVersion)就重读,和 PDF 同一个版本号。 */
  private readonly _imageWatches = new Map<string, IReactionDisposer>();
  private readonly _ctx: FileModelContext;

  constructor(ctx: FileModelContext) {
    this._ctx = ctx;
  }

  /**
   * Register interest in the Monaco models for `path` from `resource`.
   * If models are already registered, notifies `resource` immediately.
   * If this is the first acquire for `path`, starts async model registration.
   */
  acquire(path: string, resource: FileTabResource): void {
    const existing = this._entries.get(path);
    if (existing) {
      existing.resources.add(resource);
      // Notify the new resource of current state (if registration has settled).
      this._applyState(resource, existing);
      return;
    }

    // First retain — start registration.
    const entry: EntryState = { status: 'pending', resources: new Set([resource]) };
    this._entries.set(path, entry);
    this._externalPaths.set(path, resource.isExternal);
    if (!resource.isExternal) this._watchDirectoryOf(path);
    void this._registerModels(path);
  }

  /**
   * 告诉这个文件所在的机器「我在看它所在的目录」:一个目录一个 watch 的平台(Linux)上,工作区的变化流只看
   * 被这样报过的目录和展开着的目录(@@@tree-by-directories)。工作区之外的文件不属于任何变化流,不报。
   */
  private _watchDirectoryOf(path: string): void {
    const { projectId, workspaceId } = this._ctx;
    const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    if (!dir) return;
    this._directoryWatches.set(
      path,
      workspaceRpc(projectId)
        .files.watchDirectory(projectId, workspaceId, dir)
        .then((result) => (result.success ? result.data.leaseId : null))
        .catch(() => null)
    );
  }

  private _releaseDirectoryWatch(path: string): void {
    const lease = this._directoryWatches.get(path);
    if (!lease) return;
    this._directoryWatches.delete(path);
    const { projectId, workspaceId } = this._ctx;
    void lease.then((leaseId) => {
      if (leaseId) void workspaceRpc(projectId).files.releaseDirectoryWatch(projectId, workspaceId, leaseId).catch(() => {});
    });
  }

  /** Which root a path is addressed under — see EXTERNAL_MODEL_ROOT. */
  private _rootFor(path: string): string {
    return this._externalPaths.get(path) ? EXTERNAL_MODEL_ROOT : this._ctx.modelRootPath;
  }

  /**
   * Deregister interest in the Monaco models for `path` from `resource`.
   * When no resources remain for `path`, unregisters the Monaco models.
   */
  release(path: string, resource: FileTabResource): void {
    const entry = this._entries.get(path);
    if (!entry) return;
    entry.resources.delete(resource);
    if (entry.resources.size > 0) return;

    // Last release — tear down Monaco models.
    this._entries.delete(path);
    this._imageWatches.get(path)?.();
    this._imageWatches.delete(path);
    this._releaseDirectoryWatch(path);
    this._unregisterModels(path);
  }

  dispose(): void {
    for (const path of this._entries.keys()) {
      this._unregisterModels(path);
    }
    for (const stop of this._imageWatches.values()) stop();
    this._imageWatches.clear();
    for (const path of [...this._directoryWatches.keys()]) this._releaseDirectoryWatch(path);
    this._entries.clear();
  }

  /**
   * 用户在「文件很大」那张卡片上按了「仍然打开」(#5763)。
   *
   * 把这个文件按**硬顶**重读一次:先拆掉上一次留下的 too-large 模型状态,再走同一条注册路径。
   * ❌ 不另立一条读取实现 —— 那条路上的寻址、binary 判定、状态回填都得原样再写一遍,
   * 迟早分叉。
   */
  openAnyway(path: string): void {
    const entry = this._entries.get(path);
    if (!entry || entry.status !== 'too-large') return;

    this._unregisterModels(path);
    const pending: EntryState = { status: 'pending', resources: entry.resources };
    runInAction(() => {
      this._entries.set(path, pending);
      for (const res of entry.resources) {
        // 回到这个文件本来的类型,让它重新走一遍加载 —— 否则卡片会一直钉在 too-large 上。
        res.setContentType(getFileKind(path));
      }
    });
    void this._registerModels(path, EDITOR_HARD_MAX_FILE_BYTES);
  }

  private async _registerModels(path: string, maxBytes?: number): Promise<void> {
    const kind = getFileKind(path);

    // SVG is both previewable and editable. Keep it on the text/Monaco path so
    // SvgRenderer can read the live buffer and source mode has a real model;
    // only raster images use the binary image reader.
    if (kind === 'image') {
      if (!this._imageWatches.has(path)) {
        this._imageWatches.set(
          path,
          reaction(
            () => modelRegistry.diskVersion(this._ctx.workspaceId, path),
            () => void this._registerModels(path)
          )
        );
      }
      const result = await workspaceRpc(this._ctx.projectId).files.readImage(
        this._ctx.projectId,
        this._ctx.workspaceId,
        path
      );
      const dataUrl = result.success && result.data.success ? result.data.dataUrl : '';
      runInAction(() => {
        const entry = this._entries.get(path);
        if (!entry) return;
        const newState: EntryState = { status: 'image', dataUrl, resources: entry.resources };
        this._entries.set(path, newState);
        for (const res of entry.resources) {
          this._applyState(res, newState);
        }
      });
      return;
    }

    if (isMonacoBackedKind(kind)) {
      const language = getMonacoLanguageId(path);
      const root = this._rootFor(path);

      try {
        await modelRegistry.registerModel(
          this._ctx.projectId,
          this._ctx.workspaceId,
          root,
          path,
          language,
          'disk',
          undefined,
          maxBytes
        );
      } catch {
        runInAction(() => {
          const entry = this._entries.get(path);
          if (!entry) return;
          const newState: EntryState = { status: 'error', resources: entry.resources };
          this._entries.set(path, newState);
          for (const res of entry.resources) {
            this._applyState(res, newState);
          }
        });
        return;
      }

      const bufferUri = buildMonacoModelPath(root, path);
      const diskUri = modelRegistry.toDiskUri(bufferUri);
      if (modelRegistry.modelStatus.get(diskUri) === 'too-large') {
        const totalSize = modelRegistry.modelTotalSizes.get(diskUri) ?? 0;
        runInAction(() => {
          const entry = this._entries.get(path);
          if (!entry) return;
          const newState: EntryState = {
            status: 'too-large',
            totalSize,
            resources: entry.resources,
          };
          this._entries.set(path, newState);
          for (const res of entry.resources) {
            this._applyState(res, newState);
          }
        });
        return;
      }

      if (modelRegistry.modelStatus.get(diskUri) === 'binary') {
        runInAction(() => {
          const entry = this._entries.get(path);
          if (!entry) return;
          const newState: EntryState = { status: 'binary', resources: entry.resources };
          this._entries.set(path, newState);
          for (const res of entry.resources) this._applyState(res, newState);
        });
        return;
      }

      // The editable buffer is all a file tab needs: a file on your own machine is yours
      // to edit, workspace or not (#5585). Git models belong to the diff view, which
      // registers and releases its own.
      await modelRegistry.registerModel(
        this._ctx.projectId,
        this._ctx.workspaceId,
        root,
        path,
        language,
        'buffer'
      );

      runInAction(() => {
        const entry = this._entries.get(path);
        if (!entry) return;
        const newState: EntryState = { status: 'ready', resources: entry.resources };
        this._entries.set(path, newState);
        for (const res of entry.resources) {
          this._applyState(res, newState);
        }
      });
      return;
    }

    // Non-Monaco, non-image (e.g. binary, PDF): treat as ready without model.
    runInAction(() => {
      const entry = this._entries.get(path);
      if (!entry) return;
      const newState: EntryState = { status: 'ready', resources: entry.resources };
      this._entries.set(path, newState);
      for (const res of entry.resources) {
        this._applyState(res, newState);
      }
    });
  }

  private _unregisterModels(path: string): void {
    const uri = buildMonacoModelPath(this._ctx.modelRootPath, path);
    modelRegistry.unregisterModel(uri);
    modelRegistry.unregisterModel(modelRegistry.toDiskUri(uri));
    void workspaceRpc(this._ctx.projectId).editor.clearBuffer(this._ctx.projectId, this._ctx.workspaceId, path);
  }

  private _applyState(resource: FileTabResource, state: EntryState): void {
    switch (state.status) {
      case 'image':
        resource.setImageContent(state.dataUrl);
        break;
      case 'too-large':
        resource.setContentType('too-large');
        resource.setTotalSize(state.totalSize);
        break;
      case 'error':
        resource.setContentType('file-error');
        break;
      case 'binary':
        resource.setContentType('binary');
        break;
      case 'pending':
      case 'ready':
        // Nothing to set yet; resource stays in default state.
        break;
    }
  }
}

const _registry = new Map<string, FileModelManager>();

export function getFileModelManager(workspaceId: string, ctx: FileModelContext): FileModelManager {
  const existing = _registry.get(workspaceId);
  if (existing) return existing;
  const manager = new FileModelManager(ctx);
  _registry.set(workspaceId, manager);
  return manager;
}

export function releaseFileModelManager(workspaceId: string): void {
  const manager = _registry.get(workspaceId);
  if (!manager) return;
  manager.dispose();
  _registry.delete(workspaceId);
}
