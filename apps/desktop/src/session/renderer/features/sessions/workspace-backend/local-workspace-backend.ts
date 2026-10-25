import { messageForUser } from '@/lib/userFacingError';
// 这台电脑上的会话工作区:动词就是 `rpc.workspace` 本身,其余几格照此前本机的做法。
// 与别的机器那一份(remote-hosts/workspace/remote-workspace-backend.ts)同形 —— 界面只认 WorkspaceBackend。
import { toast } from '@renderer/lib/hooks/use-toast';
import { getDraggedFilePaths } from '@renderer/lib/drag-files';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { basenameFromAnyPath } from '@shared/path-name';
import type { WorkspaceBackend } from './workspace-backend';
import type { WorkspaceTerminals } from './workspace-terminal-backend';
import type { WorkspaceTreeBackend, WorkspaceTreeResult, WorkspaceTreeScope } from './workspace-tree-backend';

let localTerminals: (sessionId: string) => WorkspaceTerminals | null = () => null;

/**
 * 本机终端的来源由 terminal-registry 装上时登记 —— ❌ 在这里 import 它:那一串(终端 → pty)会被拖进
 * 每个只想读文件的模块(模型注册表、文件树),单测与启动都白白多背一截。
 */
export function bindLocalTerminals(get: (sessionId: string) => WorkspaceTerminals | null): void {
  localTerminals = get;
}

type ResultLikeError = { message?: string; type?: string; paths?: readonly string[] };

/** message / type 都是底层原始诊断,原样返回;两者皆无时才落到本地化兜底。 */
function resultErrorMessage(error: ResultLikeError): string {
  return error.message ?? error.type ?? translateSessionMessage('fileTree.unknownError');
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 从访达拖进来的文件复制进工作区(乐观插进树里;同名先问「替换」)。 */
async function importLocalFiles(scope: WorkspaceTreeScope, srcPaths: string[], destDirPath: string, overwrite = false): Promise<void> {
  const { files, projectId, workspaceId } = scope;
  // 乐观插入 —— 落下那一刻树就更新;拷完之后监视推过来的那一下对已在的节点是空操作。
  const inserted =
    files?.addOptimisticNodes(
      srcPaths.map((srcPath) => ({ path: joinPath(destDirPath, basenameFromAnyPath(srcPath)), type: 'file' as const }))
    ) ?? [];

  const handleFailure = async (error: ResultLikeError) => {
    for (const p of inserted) files?.removeNode(p);
    await files?.registerDir(destDirPath, true);
    const existingPaths = error.type === 'conflict' && Array.isArray(error.paths) ? [...error.paths] : [];
    if (existingPaths.length > 0 && !overwrite) {
      // 冲突的文件路径是数据,逐字带进外壳。
      showModal('confirmActionModal', {
        title: translateSessionMessage('fileTree.replaceTitle', { count: existingPaths.length }),
        description: translateSessionMessage('fileTree.replaceDescription', {
          count: existingPaths.length,
          paths: existingPaths.join(', '),
        }),
        confirmLabel: translateSessionMessage('fileTree.replace'),
        variant: 'destructive',
        onSuccess: () => void importLocalFiles(scope, srcPaths, destDirPath, true),
      });
      return;
    }
    log.error('[file-tree] copying dropped files failed', { destDirPath, error: resultErrorMessage(error) });
    toast({ title: translateSessionMessage('fileTree.importFailed'), description: messageForUser(resultErrorMessage(error)), variant: 'destructive' });
  };

  try {
    const result = await rpc.workspace.files.copyLocalFiles(projectId, workspaceId, srcPaths, destDirPath, { overwrite });
    if (!result.success) {
      await handleFailure(result.error);
      return;
    }
    files?.confirmOptimisticNodes(inserted);
  } catch (error) {
    await handleFailure({
      type: 'fs_error',
      message: messageForUser(error),
    });
  }
}

function entryFailure(error: { type: string; message?: string }): WorkspaceTreeResult<never> {
  if (error.type === 'exists') return { ok: false, failure: { code: 'exists', message: error.message ?? '' } };
  if (error.type === 'invalid_name') return { ok: false, failure: { code: 'invalid_name', message: error.message ?? '' } };
  return { ok: false, failure: { code: 'failed', message: resultErrorMessage(error) } };
}

const localTree: WorkspaceTreeBackend = {
  deleteMode: 'permanent',
  canReveal: true,
  async create(scope, dir, name, kind) {
    const result = await rpc.workspace.files.createEntry(scope.projectId, scope.workspaceId, dir, name, kind);
    return result.success ? { ok: true, value: result.data } : entryFailure(result.error);
  },
  async rename(scope, path, name) {
    const result = await rpc.workspace.files.renameEntry(scope.projectId, scope.workspaceId, path, name);
    return result.success ? { ok: true, value: result.data } : entryFailure(result.error);
  },
  async remove(scope, entry) {
    const result = await rpc.workspace.files.removeFile(scope.projectId, scope.workspaceId, entry.path, {
      recursive: entry.kind === 'directory',
    });
    if (!result.success) return entryFailure(result.error);
    if (!result.data.success) {
      return {
        ok: false,
        failure: { code: 'failed', message: result.data.error ?? translateSessionMessage('fileTree.deleteFailedFallback') },
      };
    }
    return { ok: true, value: { mode: 'permanent' } };
  },
  importDropped(scope, dir, dataTransfer) {
    const srcPaths = getDraggedFilePaths(dataTransfer);
    if (srcPaths.length === 0) return Promise.resolve();
    return importLocalFiles(scope, srcPaths, dir);
  },
};

export const localWorkspaceBackend: WorkspaceBackend = {
  machine: { kind: 'local' },
  rpc: rpc.workspace,
  browseDirectory: (_workspaceId, path) => rpc.files.browseDirectory({ type: 'local', path }),
  tree: localTree,
  browser: { available: true, persistent: true, attach: () => null },
  terminal: {
    available: true,
    persistent: true,
    terminals: (ctx) => localTerminals(ctx.sessionId),
  },
};
