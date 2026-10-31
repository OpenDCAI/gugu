import { log } from '@renderer/utils/logger';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import { observable, runInAction } from 'mobx';
import type * as monaco from 'monaco-editor';
import { diffHunks, mergeThreeWay } from '@/session/app-runtime/apply-from';
import type { DiffViewState } from '@renderer/lib/editor/diff-view-state';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { HEAD_REF, type GitRef } from '@shared/core/git/types';
import { gitRefToString, refsEqual } from '@shared/core/git/utils';
import { buildMonacoModelPath, isExternalModelRoot } from './monacoModelPath';
import { workspaceBackend, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

const BUFFER_DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Discriminated-union entry types
// ---------------------------------------------------------------------------

interface BufferModelEntry {
  type: 'buffer';
  model: monaco.editor.ITextModel;
  /** Monaco cursor/scroll/folding state, saved between tab switches. */
  viewState: monaco.editor.ICodeEditorViewState | null;
  refs: number;
  projectId: string;
  workspaceId: string;
  filePath: string;
  language: string;
  /** Inherited from the disk model: decides which write RPC saving this buffer uses. */
  external: boolean;
}

interface DiskModelEntry {
  type: 'disk';
  model: monaco.editor.ITextModel;
  refs: number;
  projectId: string;
  workspaceId: string;
  filePath: string;
  language: string;
  /** True when filePath is an absolute path outside every workspace (see EXTERNAL_MODEL_ROOT). */
  external: boolean;
}

interface GitModelEntry {
  type: 'git';
  model: monaco.editor.ITextModel;
  refs: number;
  projectId: string;
  workspaceId: string;
  filePath: string;
  language: string;
  /** The git ref — HEAD for the current commit; structured ref for PR/merge-target diffs. */
  ref: GitRef;
}

type ModelEntry = BufferModelEntry | DiskModelEntry | GitModelEntry;
export type ModelType = 'buffer' | 'disk' | 'git';
export type ModelStatus = 'loading' | 'ready' | 'error' | 'too-large' | 'binary';

/**
 * Manages up to three Monaco ITextModel instances per open file using a single
 * unified map keyed by Monaco URI string.
 *
 *   buffer  (file://)  — writable; shown in the code editor; holds user edits + undo stack
 *   disk    (disk://)  — read-only mirror of the current on-disk content; updated by watcher
 *   git     (git://)   — read-only snapshot of a git ref (HEAD or arbitrary ref)
 *
 * ### Lifecycle
 *
 * **Registration** (`registerModel` / `unregisterModel`): ref-counted. Models are kept in memory
 * for 60 s after the last `unregisterModel` call, then evicted. Re-registering before the timer
 * fires cancels the eviction.
 *
 * **Invalidation**: the registry is a pure SWR cache — it does not subscribe to any events.
 * Callers must wire external invalidation bridges (see `invalidation-bridges.ts`) that translate
 * FS/git events into `invalidateModel(uri)` calls. Use `findGitUris` / `findDiskUris` to query
 * which URIs are affected by a given event.
 *
 * Binary files must be filtered by callers before registering (use `getFileKind` from fileKind.ts).
 */
export class MonacoModelRegistry {
  /**
   * Unified model map. Key is the Monaco URI string (scheme encodes entry type).
   *   file://  → BufferModelEntry
   *   disk://  → DiskModelEntry
   *   git://   → GitModelEntry
   *
   * Plain Map — Monaco ITextModel instances are imperative/mutable; not observable.
   */
  private modelMap = new Map<string, ModelEntry>();

  /**
   * Diff editor view states keyed by `${originalUri}::${modifiedUri}`.
   * Saves and restores scroll/selection for the diff editor across tab switches,
   * mirroring how BufferModelEntry.viewState works for regular file tabs.
   * Entries are swept out when either constituent model is evicted (see unregisterModel).
   */
  private diffViewStates = new Map<string, DiffViewState>();

  // ---------------------------------------------------------------------------
  // Monaco readiness — awaited before creating any ITextModel instance.
  // ---------------------------------------------------------------------------

  /**
   * Resolves once monacoBootstrap.init() completes.
   * notifyMonacoReady() is called by the bootstrap; the promise is idempotent
   * after the first resolution.
   */
  private readonly monacoReadyPromise: Promise<typeof monaco>;
  private resolveMonacoReady!: (m: typeof monaco) => void;
  private monacoResolved = false;

  constructor() {
    this.monacoReadyPromise = new Promise<typeof monaco>((resolve) => {
      this.resolveMonacoReady = resolve;
    });
  }

  /**
   * Called by monacoBootstrap after Monaco finishes loading.
   * Safe to call multiple times — only the first call has any effect.
   */
  notifyMonacoReady(m: typeof monaco): void {
    if (this.monacoResolved) return;
    this.monacoResolved = true;
    this.resolveMonacoReady(m);
  }

  private reloadingFromDisk = new Set<string>();

  /**
   * 盘上这份文件已经没了(外部删掉)的缓冲区 URI:页签标「已删除」、正文留着,存一下就重新建出来(照 VS Code)。
   * 由 disk 模型重读失败后问一次「还在不在」得出;再读到 / 存下去就清掉。
   */
  readonly deletedOnDisk = observable.set<string>();

  private bufferReadyCallbacks = new Map<string, Array<() => void>>();

  /**
   * In-flight fetch deduplication. Prevents duplicate RPCs when two callers
   * register the same file concurrently before either resolves.
   * Key: `{projectId}:{workspaceId}:{filePath}:disk` or `…:git:{ref}`
   */
  private pendingFetches = new Map<string, Promise<any>>();

  // ---------------------------------------------------------------------------
  // MobX reactive state
  // ---------------------------------------------------------------------------

  /**
   * Model loading status — observable. Drives useModelStatus() in observer() components.
   */
  readonly modelStatus = observable.map<string, ModelStatus>();

  /**
   * Total file size in bytes for disk:// URIs where the file was too large to load into Monaco.
   * Keyed by disk:// URI. Used to display file size in the tab bar tooltip and TooLargeRenderer.
   */
  readonly modelTotalSizes = observable.map<string, number>();

  /**
   * Set of buffer URIs (file://) that have unsaved changes relative to disk.
   * Drives useIsDirty() in observer() components.
   */
  readonly dirtyUris = observable.set<string>();

  /**
   * Monotonically-increasing content version for each buffer URI (file://).
   * Incremented on every content change and set to 1 on initial buffer creation.
   * Observable so components that read buffer text (e.g. MarkdownEditorRenderer)
   * can subscribe reactively without polling — read this before calling getValue().
   */
  readonly bufferVersions = observable.map<string, number>();
  /**
   * 盘上这个文件变过几次(按工作区 + 路径,分隔符归一)。给不走 Monaco 模型的读者用 —— 图片、PDF 读一次字节就画,
   * 自己收不到磁盘变化,读这个版本号、它动了就重读。和模型共用一条来源:`files:changes` → invalidation bridge。
   */
  private readonly diskVersions = observable.map<string, number>();
  /** 整个工作区重扫过几次:事件可能丢了,它下面每个文件都当作变过。 */
  private readonly diskResyncs = observable.map<string, number>();

  diskVersion(workspaceId: string, filePath: string): number {
    return (this.diskResyncs.get(workspaceId) ?? 0) + (this.diskVersions.get(`${workspaceId}\0${samePathKey(filePath)}`) ?? 0);
  }

  /** 一条盘上变化(`filePath`),或这个工作区整体重扫(不给路径)。 */
  noteDiskChange(workspaceId: string, filePath?: string): void {
    const [map, key] = filePath === undefined ? [this.diskResyncs, workspaceId] : [this.diskVersions, `${workspaceId}\0${samePathKey(filePath)}`];
    runInAction(() => map.set(key, (map.get(key) ?? 0) + 1));
  }

  /**
   * 60 s TTL timers. Started in unregisterModel when refs drop to 0.
   * Cancelled if the model is re-registered before the timer fires.
   */
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Debounce timers for crash-recovery buffer autosave, keyed by buffer URI. */
  private bufferAutosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** model.onDidChangeContent disposables for each registered buffer, keyed by buffer URI. */
  private bufferContentDisposables = new Map<string, { dispose(): void }>();

  // ---------------------------------------------------------------------------
  // URI helpers (public)
  // ---------------------------------------------------------------------------

  toDiskUri(bufferUri: string): string {
    return bufferUri.replace(/^file:\/\//, 'disk://');
  }

  /**
   * Convert a buffer URI (file://) to a git:// URI for the given ref.
   * Ref is percent-encoded so slashes in branch names (e.g. origin/main) are safe.
   * Example: file://workspace:abc/src/index.ts + HEAD_REF → git://workspace:abc/HEAD/src/index.ts
   */
  toGitUri(bufferUri: string, ref: GitRef): string {
    const refStr = gitRefToString(ref);
    const withoutScheme = bufferUri.replace(/^file:\/\//, '');
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx < 0) return bufferUri;
    const root = withoutScheme.slice(0, slashIdx);
    const filePath = withoutScheme.slice(slashIdx + 1);
    return `git://${root}/${encodeURIComponent(refStr)}/${filePath}`;
  }

  // ---------------------------------------------------------------------------
  // Dedup fetch
  // ---------------------------------------------------------------------------

  private dedupFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pendingFetches.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.pendingFetches.delete(key));
    this.pendingFetches.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------------------
  // Register (public API)
  // ---------------------------------------------------------------------------

  /**
   * Register (or increment the reference count of) a model for `filePath`.
   *
   * - `'disk'`   — fetches disk content via RPC, creates `disk://` model.
   * - `'git'`    — fetches git content via RPC; creates `git://` model.
   * - `'buffer'` — seeds from the existing disk model (disk must be registered first).
   *               Creates `file://` model, fires any queued `onceBufferReady` callbacks.
   *
   * Idempotent: if the model already exists, just increments ref count and returns the URI.
   *
   * @returns the buffer URI string (same for all three types of the same file)
   */
  async registerModel(
    projectId: string,
    workspaceId: string,
    modelRootPath: string,
    filePath: string,
    language: string,
    type: ModelType,
    ref: GitRef = HEAD_REF,
    /**
     * 这一次允许读多大。默认是「先问一句」那条线;用户在 too-large 卡片上按了
     * 「仍然打开」时传 `EDITOR_HARD_MAX_FILE_BYTES`(#5763)。
     */
    maxBytes: number = EDITOR_CONFIRM_FILE_BYTES
  ): Promise<string> {
    const uri = buildMonacoModelPath(modelRootPath, filePath);
    const external = isExternalModelRoot(modelRootPath);

    switch (type) {
      case 'disk':
        return this.registerDisk(projectId, workspaceId, uri, filePath, language, external, maxBytes);
      case 'git':
        return this.registerGit(projectId, workspaceId, uri, filePath, language, ref);
      case 'buffer':
        return this.registerBuffer(uri, language);
    }
  }

  private async registerDisk(
    projectId: string,
    workspaceId: string,
    uri: string,
    filePath: string,
    language: string,
    external = false,
    maxBytes: number = EDITOR_CONFIRM_FILE_BYTES
  ): Promise<string> {
    const diskUri = this.toDiskUri(uri);
    const existing = this.modelMap.get(diskUri);

    if (existing?.type === 'disk') {
      existing.refs += 1;
      const timer = this.evictionTimers.get(diskUri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(diskUri);
      }
      return uri;
    }

    runInAction(() => this.modelStatus.set(diskUri, 'loading'));

    // Run the RPC fetch and Monaco initialization in parallel — no need to wait
    // for Monaco before fetching file content from the main process.
    let content: string;
    let m: typeof monaco;
    try {
      // maxBytes 进 key:同一个文件「先问一句」与「仍然打开」是两次不同的读取,
      // 少了它第二次会被 dedup 缓存直接喂回第一次那个「太大」的结果(#5763)。
      const fetchKey = `${projectId}:${workspaceId}:${filePath}:disk:${external ? 'ext' : 'ws'}:${maxBytes}`;
      type DiskFetchResult = {
        content: string;
        binary?: boolean;
        truncated: boolean;
        totalSize: number;
      };
      const [fetchResult, monaco_] = await Promise.all([
        this.dedupFetch<DiskFetchResult>(fetchKey, async () => {
          // Outside the workspace the path is absolute and only readExternalFile accepts
          // it; both calls answer with the same shape (content / binary / truncated / size),
          // so everything downstream — status, eviction, too-large — stays one code path.
          const res = external
            ? await workspaceRpc(projectId).files.readExternalFile(projectId, workspaceId, filePath, maxBytes)
            : await workspaceRpc(projectId).files.readFile(projectId, workspaceId, filePath, maxBytes);
          if (!res.success) {
            const detail = 'message' in res.error ? res.error.message : JSON.stringify(res.error);
            throw new Error(`registerModel(disk): readFile failed for ${filePath}: ${detail}`);
          }
          const result = res.data.content;
          if (result === null) throw new Error(`registerModel(disk): null content for ${filePath}`);
          return {
            content: result,
            binary: res.data.binary,
            truncated: res.data.truncated,
            totalSize: res.data.totalSize,
          };
        }),
        this.monacoReadyPromise,
      ]);

      // File too large to load into Monaco — mark status and bail out without creating a model.
      if (fetchResult.truncated) {
        runInAction(() => {
          this.modelStatus.set(diskUri, 'too-large');
          this.modelTotalSizes.set(diskUri, fetchResult.totalSize);
        });
        return uri;
      }

      if (fetchResult.binary) {
        runInAction(() => {
          this.modelStatus.set(diskUri, 'binary');
        });
        return uri;
      }

      content = fetchResult.content;
      m = monaco_;
    } catch (err) {
      runInAction(() => this.modelStatus.set(diskUri, 'error'));
      throw err;
    }

    const diskMonacoUri = m.Uri.parse(diskUri);
    let model = m.editor.getModel(diskMonacoUri);
    if (!model) model = m.editor.createModel(content, language, diskMonacoUri);
    const entry: DiskModelEntry = {
      type: 'disk',
      model,
      refs: 1,
      projectId,
      workspaceId,
      filePath,
      language,
      external,
    };
    this.modelMap.set(diskUri, entry);

    runInAction(() => this.modelStatus.set(diskUri, 'ready'));

    return uri;
  }

  private async registerGit(
    projectId: string,
    workspaceId: string,
    uri: string,
    filePath: string,
    language: string,
    ref: GitRef
  ): Promise<string> {
    const gitUri = this.toGitUri(uri, ref);
    const existing = this.modelMap.get(gitUri);

    if (existing?.type === 'git') {
      existing.refs += 1;
      const timer = this.evictionTimers.get(gitUri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(gitUri);
      }
      return uri;
    }

    runInAction(() => this.modelStatus.set(gitUri, 'loading'));

    // Run the RPC fetch and Monaco initialization in parallel.
    const fetchKey = `${projectId}:${workspaceId}:${filePath}:git:${gitRefToString(ref)}`;
    let content: string | null;
    let m: typeof monaco;
    try {
      [content, m] = await Promise.all([
        this.dedupFetch(fetchKey, async () => {
          if (ref.kind === 'staged') {
            const res = await workspaceRpc(projectId).gitWorktree.getFileAtIndex(
              projectId,
              workspaceId,
              filePath
            );
            if (!res.success) throw new Error(`Cannot read git index: ${JSON.stringify(res.error)}`);
            return res.data.content;
          }
          const res = await workspaceRpc(projectId).gitWorktree.getFileAtRef(
            projectId,
            workspaceId,
            filePath,
            gitRefToString(ref)
          );
          if (!res.success) throw new Error(`Cannot read git ref: ${JSON.stringify(res.error)}`);
          return res.data.content;
        }),
        this.monacoReadyPromise,
      ]);
    } catch (error) {
      runInAction(() => this.modelStatus.set(gitUri, 'error'));
      throw error;
    }

    const gitMonacoUri = m.Uri.parse(gitUri);
    let model = m.editor.getModel(gitMonacoUri);
    if (!model) model = m.editor.createModel(content ?? '', language, gitMonacoUri);
    const entry: GitModelEntry = {
      type: 'git',
      model,
      refs: 1,
      projectId,
      workspaceId,
      filePath,
      language,
      ref,
    };
    this.modelMap.set(gitUri, entry);

    runInAction(() => this.modelStatus.set(gitUri, 'ready'));

    return uri;
  }

  private async registerBuffer(uri: string, language: string): Promise<string> {
    const existing = this.modelMap.get(uri);

    if (existing?.type === 'buffer') {
      existing.refs += 1;
      const timer = this.evictionTimers.get(uri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(uri);
      }
      // Re-attach the content-change listener if it was eagerly disposed when
      // refs previously dropped to 0 (tab close), but the model survived the
      // 60 s eviction window and is now being re-registered.
      if (!this.bufferContentDisposables.has(uri)) {
        const disposable = existing.model.onDidChangeContent(() => {
          if (this.reloadingFromDisk.has(uri)) return;
          runInAction(() => {
            if (this.computeIsDirtyRaw(uri)) this.dirtyUris.add(uri);
            else this.dirtyUris.delete(uri);
            this.bufferVersions.set(uri, (this.bufferVersions.get(uri) ?? 0) + 1);
          });
          const existingTimer = this.bufferAutosaveTimers.get(uri);
          if (existingTimer) clearTimeout(existingTimer);
          this.bufferAutosaveTimers.set(
            uri,
            setTimeout(() => {
              this.bufferAutosaveTimers.delete(uri);
              const currentEntry = this.modelMap.get(uri);
              if (!currentEntry || currentEntry.type !== 'buffer') return;
              if (!this.isDirty(uri)) return;
              const value = currentEntry.model.getValue();
              void workspaceRpc(currentEntry.projectId).editor.saveBuffer(
                currentEntry.projectId,
                currentEntry.workspaceId,
                currentEntry.filePath,
                value
              );
            }, BUFFER_DEBOUNCE_MS)
          );
        });
        this.bufferContentDisposables.set(uri, disposable);
      }
      return uri;
    }

    const m = await this.monacoReadyPromise;

    const diskEntry = this.modelMap.get(this.toDiskUri(uri));
    const seedContent = diskEntry?.type === 'disk' ? diskEntry.model.getValue() : '';
    const projectId = diskEntry?.projectId ?? '';
    const workspaceId = diskEntry?.workspaceId ?? '';
    const filePath = diskEntry?.filePath ?? '';
    const external = diskEntry?.type === 'disk' ? diskEntry.external : false;

    {
      const bufferMonacoUri = m.Uri.parse(uri);
      let model = m.editor.getModel(bufferMonacoUri);
      if (!model) model = m.editor.createModel(seedContent, language, bufferMonacoUri);
      const entry: BufferModelEntry = {
        type: 'buffer',
        model,
        refs: 1,
        projectId,
        workspaceId,
        filePath,
        language,
        viewState: null,
        external,
      };
      this.modelMap.set(uri, entry);

      // Attach content-change listener for dirty tracking and crash-recovery autosave.
      const disposable = model.onDidChangeContent(() => {
        if (this.reloadingFromDisk.has(uri)) return;

        // Update reactive dirty set and bump content version so observer()
        // components that render buffer text (e.g. markdown preview) re-render.
        runInAction(() => {
          if (this.computeIsDirtyRaw(uri)) this.dirtyUris.add(uri);
          else this.dirtyUris.delete(uri);
          this.bufferVersions.set(uri, (this.bufferVersions.get(uri) ?? 0) + 1);
        });

        // Debounced crash-recovery save — persists unsaved edits across app restarts.
        const existingTimer = this.bufferAutosaveTimers.get(uri);
        if (existingTimer) clearTimeout(existingTimer);
        this.bufferAutosaveTimers.set(
          uri,
          setTimeout(() => {
            this.bufferAutosaveTimers.delete(uri);
            const currentEntry = this.modelMap.get(uri);
            if (!currentEntry || currentEntry.type !== 'buffer') return;
            if (!this.isDirty(uri)) return;
            const value = currentEntry.model.getValue();
            void workspaceRpc(currentEntry.projectId).editor.saveBuffer(
              currentEntry.projectId,
              currentEntry.workspaceId,
              currentEntry.filePath,
              value
            );
          }, BUFFER_DEBOUNCE_MS)
        );
      });
      this.bufferContentDisposables.set(uri, disposable);
    }

    runInAction(() => this.modelStatus.set(uri, 'ready'));
    // Mark the buffer as having content so markdown/other renderers that depend
    // on bufferVersions can react to the initial population.
    runInAction(() => {
      this.bufferVersions.set(uri, 1);
    });

    const callbacks = this.bufferReadyCallbacks.get(uri);
    if (callbacks?.length) {
      callbacks.forEach((cb) => cb());
      this.bufferReadyCallbacks.delete(uri);
    }

    return uri;
  }

  // ---------------------------------------------------------------------------
  // Unregister (public API)
  // ---------------------------------------------------------------------------

  /**
   * Decrement the reference count for a model by its typed URI.
   * Disposes the Monaco model and cleans up subscriptions when count reaches 0.
   *
   * Pass the typed URI directly:
   *   buffer → the file:// buffer URI (same as returned by registerModel)
   *   disk   → toDiskUri(bufferUri)
   *   git    → toGitUri(bufferUri, ref)
   */
  unregisterModel(uri: string): void {
    const entry = this.modelMap.get(uri);
    if (!entry) {
      // No Monaco model was created — this can happen for too-large disk models.
      // Clean up status and size immediately since there is nothing else to evict.
      if (this.modelStatus.get(uri) === 'too-large') {
        runInAction(() => {
          this.modelStatus.delete(uri);
          this.modelTotalSizes.delete(uri);
        });
      }
      return;
    }

    entry.refs -= 1;
    if (entry.refs > 0) return;

    // refs === 0 — start 60 s cleanup timer. If the model is re-registered before
    // the timer fires, the timer is cancelled in the register* methods above.
    const t = setTimeout(() => {
      this.evictionTimers.delete(uri);
      const e = this.modelMap.get(uri);
      if (!e || e.refs > 0) return;
      if (!e.model.isDisposed()) e.model.dispose();
      this.modelMap.delete(uri);
      runInAction(() => {
        this.modelStatus.delete(uri);
        if (e.type === 'disk') this.modelTotalSizes.delete(uri);
      });
      if (e.type === 'buffer') {
        this.bufferContentDisposables.get(uri)?.dispose();
        this.bufferContentDisposables.delete(uri);
        const autosaveTimer = this.bufferAutosaveTimers.get(uri);
        if (autosaveTimer !== undefined) {
          clearTimeout(autosaveTimer);
          this.bufferAutosaveTimers.delete(uri);
        }
        this.bufferReadyCallbacks.delete(uri);
        runInAction(() => {
          this.deletedOnDisk.delete(uri);
          this.dirtyUris.delete(uri);
          this.bufferVersions.delete(uri);
        });
      }
      // Sweep any diff view states that referenced this model.
      for (const key of this.diffViewStates.keys()) {
        if (key.startsWith(uri + '::') || key.endsWith('::' + uri)) {
          this.diffViewStates.delete(key);
        }
      }
    }, 60_000);
    this.evictionTimers.set(uri, t);

    // Eagerly clean up buffer-specific in-memory state immediately (content disposables,
    // autosave timers) so that edits made in a closing tab don't fire after close.
    if (entry.type === 'buffer') {
      this.bufferContentDisposables.get(uri)?.dispose();
      this.bufferContentDisposables.delete(uri);
      const autosaveTimer = this.bufferAutosaveTimers.get(uri);
      if (autosaveTimer !== undefined) {
        clearTimeout(autosaveTimer);
        this.bufferAutosaveTimers.delete(uri);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Attach / view state
  // ---------------------------------------------------------------------------

  /**
   * Attach the buffer model to a leased code editor.
   * Saves view state for `previousUri` and restores it for `newUri`.
   */
  attach(editor: monaco.editor.IStandaloneCodeEditor, newUri: string, previousUri?: string): void {
    if (previousUri && previousUri !== newUri) {
      const prev = this.modelMap.get(previousUri);
      if (prev?.type === 'buffer') prev.viewState = editor.saveViewState();
    }

    // Any registered model can be shown — a file outside the workspace is backed by its
    // read-only disk model, and refusing to attach it left the editor holding the file
    // you looked at *before*, i.e. the source view silently showed the wrong file (#5585).
    // Only buffers carry view state, since only they are edited.
    const entry = this.modelMap.get(newUri);
    if (!entry) return;
    editor.setModel(entry.model);
    if (entry.type === 'buffer' && entry.viewState) {
      editor.restoreViewState(entry.viewState);
    }
  }

  detach(editor: monaco.editor.IStandaloneCodeEditor, previousUri?: string): void {
    if (previousUri) {
      const prev = this.modelMap.get(previousUri);
      if (prev?.type === 'buffer') prev.viewState = editor.saveViewState();
    }
    editor.setModel(null);
  }

  // ---------------------------------------------------------------------------
  // Diff view state — scroll/cursor preservation across diff tab switches
  // ---------------------------------------------------------------------------

  private diffKey(originalUri: string, modifiedUri: string): string {
    return `${originalUri}::${modifiedUri}`;
  }

  /** Remember the diff editor's viewport for this model pair (call before tearing it down). */
  saveDiffViewState(originalUri: string, modifiedUri: string, state: DiffViewState): void {
    this.diffViewStates.set(this.diffKey(originalUri, modifiedUri), state);
  }

  /** The viewport last saved for this model pair, if any. */
  restoreDiffViewState(originalUri: string, modifiedUri: string): DiffViewState | undefined {
    return this.diffViewStates.get(this.diffKey(originalUri, modifiedUri));
  }

  /**
   * Register a one-shot callback that fires when the buffer model for `uri` is created.
   * If the model already exists, fires immediately.
   * Returns a cleanup function that cancels the pending callback.
   */
  onceBufferReady(uri: string, cb: () => void): () => void {
    if (this.modelMap.has(uri)) {
      cb();
      return () => {};
    }
    const cbs = this.bufferReadyCallbacks.get(uri) ?? [];
    cbs.push(cb);
    this.bufferReadyCallbacks.set(uri, cbs);
    return () => {
      const current = this.bufferReadyCallbacks.get(uri);
      if (!current) return;
      const filtered = current.filter((c) => c !== cb);
      if (filtered.length === 0) {
        this.bufferReadyCallbacks.delete(uri);
      } else {
        this.bufferReadyCallbacks.set(uri, filtered);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Dirty state
  // ---------------------------------------------------------------------------

  /** Returns true if the buffer has unsaved changes relative to on-disk content. */
  isDirty(uri: string): boolean {
    return this.dirtyUris.has(uri);
  }

  /** Computes actual dirty state by comparing model values. Used internally to populate dirtyUris. */
  private computeIsDirtyRaw(uri: string): boolean {
    const buf = this.modelMap.get(uri);
    const disk = this.modelMap.get(this.toDiskUri(uri));
    if (!buf || buf.type !== 'buffer' || !disk || disk.type !== 'disk') return false;
    return buf.model.getValue() !== disk.model.getValue();
  }

  /**
   * Mark the current buffer content as saved.
   * Syncs the disk model to match the buffer so isDirty() returns false.
   */
  markSaved(uri: string): void {
    const buf = this.modelMap.get(uri);
    const disk = this.modelMap.get(this.toDiskUri(uri));
    if (buf?.type === 'buffer' && disk?.type === 'disk') {
      disk.model.setValue(buf.model.getValue());
      runInAction(() => {
        this.dirtyUris.delete(uri);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Content access
  // ---------------------------------------------------------------------------

  /**
   * Returns the ITextModel stored at the given typed URI, or undefined.
   * Use toDiskUri / toGitUri to construct typed URIs for disk/git entries.
   */
  getModelByUri(uri: string): monaco.editor.ITextModel | undefined {
    return this.modelMap.get(uri)?.model;
  }

  filePathForUri(uri: string): string | undefined {
    return this.modelMap.get(uri)?.filePath;
  }

  /** Current text content of the buffer model. */
  getValue(uri: string): string | null {
    const entry = this.modelMap.get(uri);
    return entry?.type === 'buffer' ? entry.model.getValue() : null;
  }

  /**
   * Text of whichever model is registered at this URI — buffer, disk or git.
   *
   * `getValue` answers only for buffers, which is right for save/dirty logic but wrong
   * for anything that just wants to show a file: a file outside the workspace is backed
   * by its read-only disk model, and asking getValue for it returns null — the shape
   * #5585 was made of (a file with content rendering as「Empty file」).
   */
  getText(uri: string): string | null {
    const entry = this.modelMap.get(uri);
    return entry ? entry.model.getValue() : null;
  }

  /** Current text content of the disk model. */
  getDiskValue(uri: string): string | null {
    const entry = this.modelMap.get(this.toDiskUri(uri));
    return entry?.type === 'disk' ? entry.model.getValue() : null;
  }

  /** True if a buffer model is registered for this URI. */
  hasModel(uri: string): boolean {
    return this.modelMap.get(uri)?.type === 'buffer';
  }

  /** True while a programmatic disk reload is in progress (suppresses false dirty flag). */
  isReloadingFromDisk(uri: string): boolean {
    return this.reloadingFromDisk.has(uri);
  }

  /**
   * Write the buffer content to disk, sync the disk model, and clear the
   * crash-recovery buffer entry.
   *
   * @returns the saved content string on success, or `null` on failure.
   */
  async saveFileToDisk(uri: string, merged = false): Promise<string | null> {
    const buf = this.modelMap.get(uri);
    if (!buf || buf.type !== 'buffer') return null;

    try {
      const content = buf.model.getValue();
      // Outside the workspace the write goes through writeExternalFile: `writeFile` is gated
      // to stay inside the workspace, which is the right leash for an agent's plan and the
      // wrong one for a person saving a file on their own machine (#5585).
      const files = workspaceRpc(buf.projectId).files;
      const write = buf.external ? files.writeExternalFile : files.writeFile;
      const result = await write(buf.projectId, buf.workspaceId, buf.filePath, content);
      if (!result.success) {
        // 盘上那份在你上次读到之后被别人改过(别的机器的写入带着版本标记,对不上就拒):重读一次,那边的改动
        // 并进你的缓冲区(与本机外部改动同一条路,两边都留),再把并好的写下去 —— 这就是你按的那一下 ⌘S。
        if ((result.error as { code?: string }).code === 'conflict' && !merged) {
          await this.invalidateModel(this.toDiskUri(uri));
          return this.saveFileToDisk(uri, true);
        }
        throw new Error(result.error.type === 'not_found' ? translateSessionMessage('taskError.fileNotFound', { path: '[path]' }) : result.error.message);
      }

      this.markSaved(uri);
      runInAction(() => this.deletedOnDisk.delete(uri));
      void workspaceRpc(buf.projectId).editor.clearBuffer(buf.projectId, buf.workspaceId, buf.filePath);
      return content;
    } catch (error) {
      log.error('Failed to save file', { path: buf.filePath, error });
      const name = buf.filePath.split('/').pop() ?? buf.filePath;
      const machine = workspaceBackend(buf.projectId).machine;
      const title = machine.kind === 'remote'
        ? translateSessionMessage('file.saveFailedOn', { name, device: machine.label() })
        : translateSessionMessage('file.saveFailed', { name });
      toast({ title, description: messageForUser(error), tier: 'error' });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Manual invalidation
  // ---------------------------------------------------------------------------

  /**
   * Re-fetch the model at `uri` from its source (disk or git). No-op for buffers.
   * Bypasses dedup cache — always fires a fresh RPC.
   *
   * 两处与首次读取对齐(#5750):寻址同样按 `entry.external` 分岔 —— 工作区外的文件只有
   * `readExternalFile` 收得下绝对路径,以前一律走 `readFile`,于是外部文件在盘上变了
   * 永远刷不出来;上限同样传 `EDITOR_CONFIRM_FILE_BYTES`,而且**截断的内容一律不许落进缓冲区**
   * —— 那等于把 cut 之后的正文从用户的文件里抹掉,下一次保存就写实了。
   */
  async invalidateModel(uri: string): Promise<void> {
    const entry = this.modelMap.get(uri);
    if (!entry) return;
    if (entry.type === 'disk') {
      const res = entry.external
        ? await workspaceRpc(entry.projectId).files.readExternalFile(
            entry.projectId,
            entry.workspaceId,
            entry.filePath,
            EDITOR_CONFIRM_FILE_BYTES
          )
        : await workspaceRpc(entry.projectId).files.readFile(
            entry.projectId,
            entry.workspaceId,
            entry.filePath,
            EDITOR_CONFIRM_FILE_BYTES
          );
      const bufferUri = uri.replace(/^disk:\/\//, 'file://');
      if (!res.success) {
        if (!entry.external) {
          const exists = await workspaceRpc(entry.projectId).files.fileExists(entry.projectId, entry.workspaceId, entry.filePath);
          if (exists.success && !exists.data.exists) runInAction(() => this.deletedOnDisk.add(bufferUri));
        }
        return;
      }
      runInAction(() => this.deletedOnDisk.delete(bufferUri));
      if (res.data.truncated) {
        // 文件在外部被写到超出上限。显形成 too-large,❌ 不拿半截内容覆盖缓冲区。
        // disk 条目的 key 就是 disk:// uri,与 `applyDiskUpdate` 的第一个参数同址。
        runInAction(() => {
          this.modelStatus.set(uri, 'too-large');
          this.modelTotalSizes.set(uri, res.data.totalSize);
        });
        return;
      }
      this.applyDiskUpdate(uri, entry, res.data.content);
    } else if (entry.type === 'git') {
      try {
        const res =
          entry.ref.kind === 'staged'
            ? await workspaceRpc(entry.projectId).gitWorktree.getFileAtIndex(
                entry.projectId,
                entry.workspaceId,
                entry.filePath
              )
            : await workspaceRpc(entry.projectId).gitWorktree.getFileAtRef(
                entry.projectId,
                entry.workspaceId,
                entry.filePath,
                gitRefToString(entry.ref)
              );
        if (res.success) {
          entry.model.setValue(res.data.content ?? '');
          runInAction(() => this.modelStatus.set(uri, 'ready'));
        } else throw new Error(`Cannot refresh git model: ${JSON.stringify(res.error)}`);
      } catch (error) {
        runInAction(() => this.modelStatus.set(uri, 'error'));
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Query methods — used by invalidation bridges to find affected URIs
  // ---------------------------------------------------------------------------

  /**
   * Return all registered git:// URIs matching the given filter.
   * Used by invalidation bridges to find which models to invalidate after an event.
   * Any filter field left undefined is treated as a wildcard.
   */
  findGitUris(filter: {
    workspaceId?: string;
    projectId?: string;
    ref?: GitRef;
    refKind?: GitRef['kind'];
  }): string[] {
    const result: string[] = [];
    for (const [uri, entry] of this.modelMap) {
      if (entry.type !== 'git') continue;
      if (filter.workspaceId !== undefined && entry.workspaceId !== filter.workspaceId) continue;
      if (filter.projectId !== undefined && entry.projectId !== filter.projectId) continue;
      if (filter.refKind !== undefined && entry.ref.kind !== filter.refKind) continue;
      if (filter.ref !== undefined && !refsEqual(filter.ref, entry.ref)) continue;
      result.push(uri);
    }
    return result;
  }

  /**
   * 这份工作区此刻在编辑器里打开着的文件(注册着 disk 模型的那几份;关掉后 60 秒的留存期内也算)。
   * 可观察:读的是 `modelStatus`,开 / 关文件时依赖它的 reaction 会重算(#6264 别的机器上的文件监视据此决定看哪几层)。
   */
  openDiskPaths(workspaceId: string): string[] {
    const paths: string[] = [];
    for (const uri of this.modelStatus.keys()) {
      if (!uri.startsWith('disk://')) continue;
      const entry = this.modelMap.get(uri);
      if (entry?.type === 'disk' && entry.workspaceId === workspaceId && !entry.external) paths.push(entry.filePath);
    }
    return paths;
  }

  /**
   * Return all registered disk:// URIs for the given workspace and file path.
   * Used by the FS-event invalidation bridge.
   */
  findDiskUris(filter: { workspaceId: string; filePath?: string }): string[] {
    const result: string[] = [];
    const wanted = filter.filePath === undefined ? undefined : samePathKey(filter.filePath);
    for (const [uri, entry] of this.modelMap) {
      if (entry.type !== 'disk') continue;
      if (entry.workspaceId !== filter.workspaceId) continue;
      if (wanted !== undefined && samePathKey(entry.filePath) !== wanted) continue;
      result.push(uri);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Disk update helper (used by invalidateModel)
  // ---------------------------------------------------------------------------

  private applyDiskUpdate(diskUri: string, entry: DiskModelEntry, newContent: string): void {
    const bufferUri = diskUri.replace(/^disk:\/\//, 'file://');
    const bufEntry = this.modelMap.get(bufferUri);
    // The disk as the buffer last knew it: what its unsaved edits were made against.
    const base = entry.model.getValue();
    entry.model.setValue(newContent);
    if (bufEntry?.type !== 'buffer') return;

    const mine = bufEntry.model.getValue();
    // No unsaved edits: the buffer becomes the disk's text. Unsaved edits: the disk's change merges in beside them, and
    // the buffer stays unsaved until ⌘S writes the merged text (F91).
    const next = !this.dirtyUris.has(bufferUri) || mine === newContent ? newContent : mergeThreeWay(base, mine, newContent);
    if (next !== mine) {
      this.reloadingFromDisk.add(bufferUri);
      // 只换变了的那几段:光标在没变的地方原地不动(VS Code 重新读回时同一个手感)。
      const model = bufEntry.model;
      model.applyEdits(
        diffHunks(mine, next).map((hunk) => {
          const start = model.getPositionAt(hunk.from);
          const end = model.getPositionAt(hunk.to);
          return {
            range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
            text: hunk.insert,
          };
        }),
        false
      );
      this.reloadingFromDisk.delete(bufferUri);
    }
    runInAction(() => {
      if (next === newContent) this.dirtyUris.delete(bufferUri);
      else this.dirtyUris.add(bufferUri);
      // 内容监听在 reloadingFromDisk 期间整段跳过(它管的是算脏与自动保存),正文版本号得在这里补上 ——
      // 预览(HTML / markdown / SVG / CSV)只认它,不加就停在旧正文上。
      if (next !== mine) this.bufferVersions.set(bufferUri, (this.bufferVersions.get(bufferUri) ?? 0) + 1);
    });
  }
}

/**
 * @@@one-file-two-spellings (#5903) —— 「这条盘上的变更是不是这个模型的文件」只在
 * `findDiskUris` 这一处判定,而它的两个输入天生拼法不同:
 *   · 文件监听喂进来的是**原生分隔符**的绝对路径(Windows 上是 `D:\\a\\b.svg`);
 *   · 模型的 `filePath` 是**打开它的那条路**给的拼法 —— 聊天里的文件链接带来的是 `D:/a/b.svg`。
 * 直接字符串比就永远不相等,于是改了盘上的文件、面板一直显示旧的,关掉重开也没用
 * (#5903 在 chole 实测:watcher 报 `D:\\…\\pelican.svg`,注册表里是 `D:/…/pelican.svg`,`hit=0`)。
 *
 * ⇒ 比之前先把分隔符归一。❌ 不在注册时改写 `entry.filePath` —— 那个值还要原样回传给主进程去读文件,
 * 改写它等于让「读哪个文件」跟着「怎么比」一起漂。模型身份本来就与拼法无关:`buildMonacoModelPath`
 * 已经把分隔符归一进 URI,所以同一个文件不同拼法本来就共用同一个 entry。
 */
function samePathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export const modelRegistry = new MonacoModelRegistry();
