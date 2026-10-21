// #6264 上传 / 下载的生产装配:字节按块走那台机器的 `workspace.files.readChunk / writeChunk`(rpc 按项目所在的机器路由),
// 落盘走这台电脑的主进程(remote-downloads.ts),「替换吗」用本机文件树拖进来同一个对话框。
// 判断都在 remote-transfers.ts;这里只接线。每个工作区一份,切走再切回来进度还在。
import { WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { RemoteTransfers, type DownloadSink, type TransferRpc } from './remote-transfers';

/** 这台电脑这一侧落盘出的错(磁盘满、没权限)—— 与「那台机器没应答」分开说。 */
export const LOCAL_WRITE_FAILED = 'local_write_failed';

function localFailure(message: string): Error {
  return Object.assign(new Error(message), { code: LOCAL_WRITE_FAILED });
}

/** 那台机器答的失败:带上它的原因码(界面按码说人话)。 */
function machineFailure(error: { type: string; message?: string }): Error {
  return Object.assign(new Error(error.message ?? error.type), { code: error.type });
}

const sink: DownloadSink = {
  async begin(name, kind) {
    const result = await rpc.app.beginRemoteDownload({ name, kind });
    if (!result.success) throw localFailure(result.error);
    return result.token && result.target ? { token: result.token, target: result.target } : null;
  },
  async write(token, segments, offset, data, final) {
    const result = await rpc.app.writeRemoteDownload({ token, segments, offset, data, final });
    if (!result.success) throw localFailure(result.error);
  },
  async finish(token, ok) {
    const result = await rpc.app.finishRemoteDownload({ token, ok });
    return result.success ? result.target : null;
  },
};

function confirmReplace(names: string[]): Promise<boolean> {
  return new Promise((resolve) =>
    showModal('confirmActionModal', {
      title: translateSessionMessage('fileTree.replaceTitle', { count: names.length }),
      description: translateSessionMessage('fileTree.replaceDescription', { count: names.length, paths: names.join(', ') }),
      confirmLabel: translateSessionMessage('fileTree.replace'),
      variant: 'destructive',
      onSuccess: () => resolve(true),
      onClose: () => resolve(false),
    })
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** 传输要的四件事,落到那台机器的路由表动词上。 */
export function machineTransferRpc(deviceId: string, projectId: string, workspaceId: string): TransferRpc {
  return {
    async listWorkspace(_deviceId, request) {
      const result = await rpcOn(deviceId).files.browseDirectory({ type: 'local', path: request.path ?? '' });
      if (!result.success) throw machineFailure({ type: result.error.type, message: 'message' in result.error ? String(result.error.message) : undefined });
      return {
        entries: result.data.map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.type === 'directory' ? ('dir' as const) : entry.type === 'symlink' ? ('symlink' as const) : ('file' as const),
          isDirectory: entry.type === 'directory',
          size: entry.size,
        })),
      };
    },
    async readWorkspaceFile(_deviceId, request) {
      const result = await rpc.workspace.files.readChunk(projectId, workspaceId, {
        path: request.path,
        offset: request.offset,
        length: request.length,
      });
      if (!result.success) throw machineFailure(result.error);
      return result.data;
    },
    async writeWorkspaceFile(_deviceId, request) {
      const { sessionId: _unused, ...chunk } = request;
      const result = await rpc.workspace.files.writeChunk(projectId, workspaceId, chunk);
      if (!result.success) throw machineFailure(result.error);
      return result.data;
    },
    async createWorkspaceEntry(_deviceId, request) {
      const path = joinPath(request.dir, request.name);
      if (request.kind === 'file') {
        // 建(或清空)这个文件:整份覆盖写一段空的。人已经点过「替换」(或本来没有同名的)。
        const result = await rpc.workspace.files.writeChunk(projectId, workspaceId, {
          path,
          uploadId: crypto.randomUUID(),
          offset: 0,
          data: '',
          total: 0,
          final: true,
          expectedEtag: WORKSPACE_WRITE_FORCE,
        });
        if (!result.success) throw machineFailure(result.error);
        return { path };
      }
      const result = await rpc.workspace.files.createEntry(projectId, workspaceId, request.dir, request.name, 'folder');
      if (result.success) return { path: result.data.path };
      if (result.error.type === 'exists') return { path };
      throw machineFailure({ type: result.error.type, message: 'message' in result.error ? result.error.message : undefined });
    },
  };
}

const byWorkspace = new Map<string, RemoteTransfers>();

export function transfersFor(deviceId: string, projectId: string, workspaceId: string): RemoteTransfers {
  const key = `${deviceId}|${projectId}|${workspaceId}`;
  let found = byWorkspace.get(key);
  if (!found) {
    const transferRpc = machineTransferRpc(deviceId, projectId, workspaceId);
    found = new RemoteTransfers({ rpc: () => transferRpc, sessionId: workspaceId, deviceId, sink, confirmReplace });
    byWorkspace.set(key, found);
  }
  return found;
}
