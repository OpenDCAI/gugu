import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import type { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import {
  buildMonacoModelPath,
  EXTERNAL_MODEL_ROOT,
  isAbsoluteFilePath,
} from '@renderer/lib/monaco/monacoModelPath';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import { log } from '@renderer/utils/logger';
import type { EditorViewSnapshot } from '@shared/view-state';
import { allFileResources, allOpenFileResources } from '../pane-selectors';
import type { FileTabResource } from './file-tab-resource';
import { FilesStore } from './files-store';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

/**
 * Manages file persistence (save) and sidebar navigation state.
 *
 * Monaco model lifecycle (retain/release) is now handled by FileModelManager,
 * which is called by FileTabResource on construction and dispose.
 * This store focuses on save-all and buffer restore. A disk change to a file with unsaved edits merges into
 * them (the model registry, F91) — there is no conflict to resolve.
 */
export class EditorViewStore implements Snapshottable<EditorViewSnapshot> {
  readonly modelRootPath: string;

  isSaving = false;

  /** Persisted navigation state for the file tree sidebar. */
  expandedPaths = observable.set<string>();

  /**
   * Per-view file-tree projection store. Created when the task session starts (`startFiles`) and
   * torn down on suspend (`disposeFiles`), so projection state lives with this view's expansion
   * state rather than being shared across all tasks on the same workspace.
   */
  files: FilesStore | null = null;

  private readonly projectId: string;
  private readonly workspaceId: string;
  private readonly paneLayout: PaneLayoutStore;

  constructor(paneLayout: PaneLayoutStore, projectId: string, workspaceId: string) {
    this.paneLayout = paneLayout;
    this.projectId = projectId;
    this.workspaceId = workspaceId;
    this.modelRootPath = `workspace:${workspaceId}`;

    makeObservable(this, {
      isSaving: observable,
      files: observable.ref,
      snapshot: computed,
    });
  }

  private stopReconcile: (() => void) | null = null;

  /**
   * Opens the per-view file-tree projection and keeps the registered directory scopes in step
   * with what is expanded. Idempotent.
   */
  startFiles(workspacePath: string | (() => string)): void {
    if (this.files) return;
    const store = new FilesStore(this.projectId, this.workspaceId, workspacePath);
    runInAction(() => {
      this.files = store;
    });
    void store.start();
    this.stopReconcile = reaction(
      () => {
        const expanded = [...this.expandedPaths].sort().join('\0');
        const loaded = [...store.loadedPaths].sort().join('\0');
        const pending = [...store.pendingPaths].sort().join('\0');
        // `nodes.size` advances as scopes load, re-triggering progressive deep registration.
        return `${expanded}::${loaded}::${pending}::${store.nodes.size}`;
      },
      () => store.reconcileVisibleScopes(this.expandedPaths),
      { fireImmediately: true }
    );
  }

  /** Closes the projection subscription and clears the per-view tree state. */
  disposeFiles(): void {
    this.stopReconcile?.();
    this.stopReconcile = null;
    const store = this.files;
    runInAction(() => {
      this.files = null;
    });
    store?.dispose();
  }

  /** Union of all open file resources across all panes. */
  get openFileResources(): FileTabResource[] {
    return allOpenFileResources(this.paneLayout);
  }

  /** Every open file tab, files outside the workspace included. */
  get allFileResources(): FileTabResource[] {
    return allFileResources(this.paneLayout);
  }

  /** Union of all open non-external file paths across all panes (deduplicated). */
  get openFilePaths(): string[] {
    const seen = new Set<string>();
    for (const r of this.openFileResources) {
      if (!r.isExternal) seen.add(r.path);
    }
    return [...seen];
  }

  get snapshot(): EditorViewSnapshot {
    return {
      expandedPaths: [...this.expandedPaths],
    };
  }

  restoreSnapshot(snapshot: Partial<EditorViewSnapshot>): void {
    if (snapshot.expandedPaths) {
      this.expandedPaths.replace(snapshot.expandedPaths);
    }
  }

  /**
   * Save one open file. Takes the buffer URI rather than a path because the path alone
   * no longer identifies a model: a file outside the workspace is addressed under its
   * own root, and only the tab knows which root it is (#5585).
   */
  async saveFile(uri: string): Promise<void> {
    if (!modelRegistry.isDirty(uri)) return;

    runInAction(() => {
      this.isSaving = true;
    });
    try {
      await modelRegistry.saveFileToDisk(uri);
    } catch (error) {
      log.error('[EditorViewStore] Error saving file:', error);
    } finally {
      runInAction(() => {
        this.isSaving = false;
      });
    }
  }

  async saveAllFiles(): Promise<void> {
    // Over resources, not paths: paths drop the files outside the workspace, and
    // 「保存全部」silently skipping one of your open files is the worst kind of miss.
    const dirty = this.allFileResources.filter((r) => r.bufferUri && r.isDirty);
    for (const resource of dirty) {
      await this.saveFile(resource.bufferUri);
    }
  }

  /**
   * Restores crash-recovery buffer content for any open tabs whose models are
   * already registered. Called by EditorProvider on mount.
   */
  async restoreBuffers(): Promise<void> {
    try {
      const buffers = await workspaceRpc(this.projectId).editor.listBuffers(this.projectId, this.workspaceId);
      for (const { filePath, content } of buffers) {
        // Drafts are keyed by the same path the file was read with, so an absolute path
        // is a file outside the workspace — the same discriminator the main process uses.
        const root = isAbsoluteFilePath(filePath) ? EXTERNAL_MODEL_ROOT : this.modelRootPath;
        const uri = buildMonacoModelPath(root, filePath);
        const model = modelRegistry.getModelByUri(uri);
        if (model) model.setValue(content);
      }
    } catch (e) {
      log.warn('[EditorViewStore] Failed to restore buffers:', e);
    }
  }

  dispose(): void {
    this.disposeFiles();
  }
}
