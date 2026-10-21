import type { TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { fileBaseName, filePathKey, resolveWorkspacePath } from '../stores/workspace-path';
import { FileTabBarItem, FileTabBarItemDragPreview } from './file-tab-item';
import { getFileModelManager } from './stores/file-model-manager';
import type { FilePayload } from './stores/file-tab-resource';
import { FileTabResource } from './stores/file-tab-resource';

export interface FileOpenArgs {
  path: string;
  /** When true, file is read-only from outside the workspace. */
  external?: boolean;
}

export const fileTabProvider: TabProvider<'file', FilePayload, FileTabResource, FileOpenArgs> =
  createTabProvider({
    kind: 'file',
    mount: 'single',
    resourceKey: (s: FilePayload) => filePathKey(s.path),

    // 工作区外的路径同样归一斜杠:原样留着的 `C:\…` 拆不出文件名,页签名就成了整条路径。
    onBeforeOpen: (args: FileOpenArgs, ctx: TabViewContext): FilePayload | null => {
      const sessionCtx = ctx as SessionTabContext;
      return {
        path: resolveWorkspacePath(sessionCtx.workspacePath, args.path),
        isExternal: args.external
      };
    },

    initialize(
      entry: TabEntry<FilePayload>,
      handle: TabHandle,
      ctx: TabViewContext
    ): FileTabResource {
      const sessionCtx = ctx as SessionTabContext;
      const modelManager = getFileModelManager(sessionCtx.workspaceId, {
        projectId: sessionCtx.projectId,
        workspaceId: sessionCtx.workspaceId,
        modelRootPath: sessionCtx.modelRootPath
      });
      return new FileTabResource(
        entry.state,
        modelManager,
        {
          projectId: sessionCtx.projectId,
          workspaceId: sessionCtx.workspaceId,
          modelRootPath: sessionCtx.modelRootPath
        },
        handle
      );
    },

    dispose(_entry: TabEntry<FilePayload>, resource: FileTabResource): void {
      resource.dispose();
    },

    async onBeforeClose(
      entry: TabEntry<FilePayload>,
      _resource: FileTabResource,
      ctx: TabViewContext
    ): Promise<boolean> {
      if (entry.state.isExternal) return true;
      const sessionCtx = ctx as SessionTabContext;
      const bufferUri = buildMonacoModelPath(sessionCtx.modelRootPath, entry.state.path);
      if (!modelRegistry.isDirty(bufferUri)) return true;

      return new Promise<boolean>((resolve) =>
        showModal('unsavedChangesModal', {
          fileName: fileBaseName(entry.state.path),
          onSuccess: (result) => {
            if (result === 'save') {
              // 没存上(冲突 / 那台机器够不着)就不关:关了等于把没存下的修改扔掉。
              void modelRegistry.saveFileToDisk(bufferUri).then((saved) => resolve(saved !== null));
            } else {
              resolve(true);
            }
          },
          onClose: () => resolve(false)
        })
      );
    },

    TabBarItem: FileTabBarItem,
    TabBarItemDragPreview: FileTabBarItemDragPreview,
    TabContent: registeredTabView('file')
  });
