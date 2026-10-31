import { action, computed, makeObservable, observable } from 'mobx';
import type { TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import {
  getFileKind,
  isMonacoBackedKind,
  isPreviewableKind,
  isSelfLoadingKind,
} from '@renderer/lib/editor/fileKind';
import type { ManagedFileKind } from '@renderer/lib/editor/types';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import {
  buildMonacoModelPath,
  EXTERNAL_MODEL_ROOT,
} from '@renderer/lib/monaco/monacoModelPath';
import { htmlTitle } from '../file-tab-label';
import type { FileModelContext, FileModelManager } from './file-model-manager';

/** Extends ManagedFileKind with terminal load-time states. */
export type FileContentType = ManagedFileKind | 'file-error' | 'too-large';

/** Whether the file is shown in Monaco (source) or its rendered preview. */
export type FileViewMode = 'source' | 'preview';

export interface FilePayload {
  path: string;
  isExternal?: boolean;
}

/**
 * Domain resource for a single open file tab.
 *
 * Holds all file-specific display state: content type, view mode, image content,
 * size, and external-file error.
 *
 * Replaces FileTabStore. The identity fields (tabId, kind, isPreview) live on
 * TabEntry; this class holds only the live/mutable view-model state.
 */
export class FileTabResource implements TabResource {
  readonly path: string;
  readonly isExternal: boolean;
  fileKind: ManagedFileKind;
  contentType: FileContentType;
  viewMode: FileViewMode;
  content: string;
  isLoading: boolean;
  totalSize: number | null;
  externalError: string | undefined;
  /** Transient position belongs to this open tab, surviving source/preview unmounts. */
  readonly htmlPreviewScroll = { x: 0, y: 0 };
  /**
   * A link from another document asked to land on this anchor (`./other.md#section`, #6950). One-shot: the preview
   * scrolls there once its text has rendered and clears it; the nonce lets the same anchor be asked for again.
   */
  revealRequest: { fragment: string; nonce: number } | null = null;

  private readonly _modelManager: FileModelManager | null;
  private readonly _modelCtx: FileModelContext | null;
  private readonly _handle: TabHandle | null;

  constructor(
    payload: FilePayload,
    modelManager?: FileModelManager,
    modelCtx?: FileModelContext,
    handle?: TabHandle
  ) {
    const fileKind = getFileKind(payload.path);
    this.path = payload.path;
    this.isExternal = payload.isExternal ?? false;
    this.fileKind = fileKind;
    this.contentType = fileKind;
    this.viewMode = isPreviewableKind(fileKind) ? 'preview' : 'source';
    this.content = '';
    // 自己取字节的类型(PDF)不进这条加载态:它的渲染器自己会 loading,而通用外部读取
    // 会把它的 contentType 盖成 binary(见 `isSelfLoadingKind`)。
    // 文本类的外部文件现在也有 model(#5585),加载态由 model 的 status 表示。这个标志位因此
    // 只剩「自己去取字节」那几类在用,同时它也是 FileContentPreview 那条外部读取的开关 ——
    // 置 false 即表示「这份正文归注册表管,别再自己读一遍」。
    const modelBacked = !this.isExternal || isMonacoBackedKind(fileKind);
    this.isLoading = isSelfLoadingKind(fileKind)
      ? false
      : fileKind === 'image'
        ? true
        : !modelBacked;
    this.totalSize = null;
    this.externalError = undefined;

    this._modelManager = modelManager ?? null;
    this._modelCtx = modelCtx ?? null;
    this._handle = handle ?? null;

    makeObservable(this, {
      fileKind: observable,
      contentType: observable,
      viewMode: observable,
      content: observable,
      isLoading: observable,
      totalSize: observable,
      externalError: observable,
      title: computed,
      revealRequest: observable.ref,
      requestReveal: action,
      clearRevealRequest: action,
      setContentType: action,
      setViewMode: action,
      setImageContent: action,
      setTotalSize: action,
      markExternalLoading: action,
      setExternalContent: action,
      setExternalBinary: action,
      setExternalTooLarge: action,
      setExternalError: action,
    });

    // Retain Monaco models for this file. Outside the workspace only the text kinds go
    // through the registry. PDFs fetch their own bytes in their renderer (`isSelfLoadingKind`);
    // images are fetched by FileContentPreview through `readImage` (`external-file-load.ts`, #6455).
    if (modelManager && this._usesModels) {
      modelManager.acquire(this.path, this);
    }
  }

  /** Whether this tab's body comes from the model registry rather than its own fetch. */
  private get _usesModels(): boolean {
    return !this.isExternal || isMonacoBackedKind(this.fileKind);
  }

  dispose(): void {
    if (this._modelManager && this._usesModels) {
      this._modelManager.release(this.path, this);
    }
  }

  onActivate?(): void {
    // No-op; file tabs don't need activation side-effects.
  }

  /**
   * HTML 页面自己起的名字(`<title>`),看预览时页签叫它;切到源码、别的文件、没有 `<title>` 时 null(页签叫文件名,
   * 照 VS Code:编辑的是文件)。读的是缓冲区:改了 `<title>` 页签跟着变,与预览看的是同一份正文。
   */
  get title(): string | null {
    if (this.fileKind !== 'html' || this.viewMode !== 'preview' || !this._modelCtx) return null;
    void modelRegistry.bufferVersions.get(this.bufferUri);
    const text = modelRegistry.getText(this.bufferUri);
    return text ? htmlTitle(text) : null;
  }

  requestReveal(fragment: string): void {
    this.revealRequest = { fragment, nonce: (this.revealRequest?.nonce ?? 0) + 1 };
  }

  clearRevealRequest(): void {
    this.revealRequest = null;
  }

  /** True when the Monaco buffer for this file has unsaved changes. */
  get isDirty(): boolean {
    if (!this._modelCtx) return false;
    return modelRegistry.dirtyUris.has(this.bufferUri);
  }

  /**
   * Which root this file is addressed under: a workspace file by「工作区 + 相对路径」,
   * a file outside every workspace by its absolute path under EXTERNAL_MODEL_ROOT.
   */
  private get _modelRoot(): string {
    if (!this._modelCtx) return '';
    return this.isExternal ? EXTERNAL_MODEL_ROOT : this._modelCtx.modelRootPath;
  }

  /**
   * The editable Monaco buffer backing this tab — one address for every reader, so no
   * renderer has to ask「这文件在工作区里面还是外面」(#5585). Inside or outside the
   * workspace, the file is shown from its buffer and saved from it; only the root and
   * the write RPC differ, and both are decided below this line.
   */
  get bufferUri(): string {
    if (!this._modelCtx) return '';
    return buildMonacoModelPath(this._modelRoot, this.path);
  }

  /** Called by the Monaco editor when the user makes the first edit — pins the tab. */
  onFirstEdit(): void {
    this._handle?.pin();
  }

  /**
   * 这个 tab 的正文归模型注册表管,因而「仍然打开」按下去真的会重读。
   * 自己取字节的类型(图片 / PDF / binary)不归它管,按钮对它们是空的 —— ❌ 那种按钮不许画出来。
   */
  get canOpenAnyway(): boolean {
    return this._modelManager != null && this._usesModels;
  }

  /**
   * 用户在「文件很大」那张卡片上按了「仍然打开」(#5763)。体积上限是**默认不替他承担代价**,
   * ❌ 不是一堵墙 —— 他说要就按硬顶再读一次。
   */
  openAnyway(): void {
    if (!this._modelManager || !this._usesModels) return;
    this._modelManager.openAnyway(this.path);
  }

  setContentType(contentType: FileContentType): void {
    this.contentType = contentType;
  }

  setViewMode(viewMode: FileViewMode): void {
    this.viewMode = viewMode;
  }

  setImageContent(content: string): void {
    this.content = content;
    this.isLoading = false;
  }

  setTotalSize(size: number): void {
    this.totalSize = size;
  }

  markExternalLoading(): void {
    this.isLoading = true;
    this.content = '';
    this.externalError = undefined;
  }

  setExternalContent(content: string): void {
    this.content = content;
    this.isLoading = false;
    this.externalError = undefined;
  }

  setExternalBinary(): void {
    this.contentType = 'binary';
    this.content = '';
    this.isLoading = false;
    this.externalError = undefined;
  }

  /**
   * 工作区外的文件大到读不完整。与 `setExternalBinary` 同形:❌ 不许把截断后的半截正文
   * 当成完整内容渲染 —— 那是看不出来的错(#5750)。
   */
  setExternalTooLarge(totalSize: number): void {
    this.contentType = 'too-large';
    this.totalSize = totalSize;
    this.content = '';
    this.isLoading = false;
    this.externalError = undefined;
  }

  setExternalError(error: string): void {
    this.content = '';
    this.isLoading = false;
    this.externalError = error;
  }
}
