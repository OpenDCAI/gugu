// #6264 别的机器上的文件树:上传(含从访达拖进来)。下载走 App 文件那一条(app-files.ts 的 downloadAppFile)。
//
// 照 VS Code 远程资源管理器(1.36 起:拖进来即上传、右键「下载...」,https://code.visualstudio.com/updates/v1_36#_remote-development):
//  · 上传:字节分段走「写文件」那个既有动词(与编辑器存回同一条,SSH 直连优先、云端中转兜底);
//    文件夹按层先建目录再传文件;同名已有先问一次「替换」(与本机文件树拖进来同一个对话框),❌ 静默覆盖;
// 每一件都有真实进度(已完成 / 总共 · 速度),能取消;失败说人话,写了一半的由落盘那一侧删掉。
//
// 上限如实:单个文件不超过 `REMOTE_WORKSPACE_MAX_FILE_BYTES`(与编辑器能打开的上限同一个数);只经云端连着的机器,每一段都走云端中转,大文件会慢 —— 进度里看得见速度。
//
// 纯逻辑(rpc、读本机文件、落盘都注入),单测钉每条分支;画在 remote-files-tab.tsx。
import { makeAutoObservable, runInAction } from 'mobx';
import {
  REMOTE_WORKSPACE_CHUNK_BYTES,
  REMOTE_WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_EXISTS_CODE,
  WORKSPACE_WRITE_FORCE,
  type SessionpageWorkspaceEntry,
  type SessionpageWorkspaceReadRequest,
  type SessionpageWorkspaceWriteRequest,
} from '@gugu/session-core/session-record/contract';
import { bytesToBase64 } from '@shared/lib/base64';

/** 要上传的一件(拖进来的文件、文件夹里的文件):相对落点的逐层名字 + 按段取字节。 */
export type UploadItem = {
  /** 例:拖进来一个文件夹 `site`,里面的 `css/a.css` → ['site', 'css', 'a.css']。 */
  segments: string[];
  size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
};

export type TransferKind = 'upload';
export type TransferStatus = 'running' | 'done' | 'failed' | 'cancelled';

export class RemoteTransfer {
  status: TransferStatus = 'running';
  done = 0;
  total = 0;
  /** 最近一段时间的速度(字节 / 秒)。 */
  bytesPerSecond = 0;
  error: unknown = null;
  /** 超过单件上限没传的那几个名字。 */
  skipped: string[] = [];
  private startedAt: number;
  cancelRequested = false;

  constructor(
    readonly id: string,
    readonly kind: TransferKind,
    readonly name: string,
    private readonly now: () => number
  ) {
    this.startedAt = now();
    makeAutoObservable<RemoteTransfer, 'now' | 'startedAt'>(this, { now: false, startedAt: false });
  }

  progress(delta: number): void {
    this.done += delta;
    const seconds = (this.now() - this.startedAt) / 1000;
    this.bytesPerSecond = seconds > 0 ? this.done / seconds : 0;
  }

  cancel(): void {
    this.cancelRequested = true;
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** 传输要问那台机器的四件事(生产装配在 remote-transfer-wiring.ts,经 rpc 路由到那台机器)。 */
export type TransferRpc = {
  listWorkspace(deviceId: string, request: { sessionId: string; path?: string }): Promise<{ entries: SessionpageWorkspaceEntry[] }>;
  readWorkspaceFile(deviceId: string, request: SessionpageWorkspaceReadRequest): Promise<{ size: number; etag: string; data: string }>;
  writeWorkspaceFile(deviceId: string, request: SessionpageWorkspaceWriteRequest): Promise<unknown>;
  createWorkspaceEntry(
    deviceId: string,
    request: { sessionId: string; dir: string; name: string; kind: 'file' | 'folder'; overwrite?: boolean }
  ): Promise<{ path: string }>;
};

export type RemoteTransfersDeps = {
  rpc: () => TransferRpc;
  sessionId: string;
  deviceId: string;
  /** 同名已有:问一次「替换」。返回 false = 人不替换(整次上传作罢)。 */
  confirmReplace: (names: string[]) => Promise<boolean>;
  now?: () => number;
  newId?: () => string;
};

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export class RemoteTransfers {
  items: RemoteTransfer[] = [];

  constructor(private readonly deps: RemoteTransfersDeps) {
    makeAutoObservable<RemoteTransfers, 'deps'>(this, { deps: false });
  }

  get active(): RemoteTransfer[] {
    return this.items.filter((item) => item.status === 'running');
  }

  /** 收起已经结束的那几行(界面上一件结束几秒后自己消失)。 */
  dismiss(transfer: RemoteTransfer): void {
    this.items = this.items.filter((item) => item !== transfer);
  }

  private begin(kind: TransferKind, name: string): RemoteTransfer {
    const now = this.deps.now ?? (() => Date.now());
    const transfer = new RemoteTransfer((this.deps.newId ?? (() => crypto.randomUUID()))(), kind, name, now);
    this.items = [...this.items, transfer];
    return transfer;
  }

  private check(transfer: RemoteTransfer): void {
    if (transfer.cancelRequested) throw new Cancelled();
  }

  private end(transfer: RemoteTransfer, error: unknown): void {
    runInAction(() => {
      if (error instanceof Cancelled) transfer.status = 'cancelled';
      else if (error) {
        transfer.status = 'failed';
        transfer.error = error;
      } else transfer.status = 'done';
    });
  }

  /**
   * 把这些东西传进那台机器上的 `dir`。返回这一次的传输(界面画进度);人拒绝替换 = null。
   * `dirName` 只用来给这一行起名(「上传 3 个文件到 src」)。
   */
  async upload(dir: string, items: UploadItem[], label: string): Promise<RemoteTransfer | null> {
    const rpc = this.deps.rpc();
    const { sessionId } = this.deps;
    const fits = items.filter((item) => item.size <= REMOTE_WORKSPACE_MAX_FILE_BYTES);
    const skipped = items.filter((item) => item.size > REMOTE_WORKSPACE_MAX_FILE_BYTES).map((item) => item.segments.join('/'));
    const topNames = [...new Set(items.map((item) => item.segments[0]!).filter(Boolean))];
    // 顶层同名已有:问一次(与本机文件树拖进来同一个对话框)。一次列目录,❌ 每个文件问一次。
    const listing = await rpc.listWorkspace(this.deps.deviceId, { sessionId, path: dir });
    const existing = new Set(listing.entries.map((entry) => entry.name));
    const clashes = topNames.filter((name) => existing.has(name));
    if (clashes.length > 0 && !(await this.deps.confirmReplace(clashes))) return null;

    const transfer = this.begin('upload', label);
    runInAction(() => {
      transfer.total = fits.reduce((sum, item) => sum + item.size, 0);
      transfer.skipped = skipped;
    });
    try {
      /** 已经建好的目录:相对路径 → 那台机器上的绝对路径。 */
      const folders = new Map<string, string>([['', dir]]);
      const folderOf = async (segments: string[]): Promise<string> => {
        let key = '';
        let at = dir;
        for (const segment of segments) {
          const next = key ? `${key}/${segment}` : segment;
          const known = folders.get(next);
          if (known) {
            at = known;
          } else {
            this.check(transfer);
            at = (await rpc.createWorkspaceEntry(this.deps.deviceId, { sessionId, dir: at, name: segment, kind: 'folder', overwrite: true })).path;
            folders.set(next, at);
          }
          key = next;
        }
        return at;
      };
      for (const item of fits) {
        this.check(transfer);
        const parent = await folderOf(item.segments.slice(0, -1));
        const name = item.segments[item.segments.length - 1]!;
        const { path } = await rpc.createWorkspaceEntry(this.deps.deviceId, { sessionId, dir: parent, name, kind: 'file', overwrite: true });
        if (item.size === 0) continue;
        const uploadId = (this.deps.newId ?? (() => crypto.randomUUID()))();
        let offset = 0;
        while (offset < item.size) {
          this.check(transfer);
          const end = Math.min(item.size, offset + REMOTE_WORKSPACE_CHUNK_BYTES);
          const bytes = await item.slice(offset, end);
          await rpc.writeWorkspaceFile(this.deps.deviceId, {
            sessionId,
            path,
            uploadId,
            offset,
            data: bytesToBase64(bytes),
            total: item.size,
            final: end >= item.size,
            // 人已经点过「替换」(或本来没有同名的,刚建的空文件就是它):整份覆盖。
            expectedEtag: WORKSPACE_WRITE_FORCE,
          });
          offset = end;
          transfer.progress(bytes.length);
        }
      }
      this.end(transfer, null);
    } catch (error) {
      this.end(transfer, error);
    }
    return transfer;
  }

}

/** 上传没成的原因里,「同名已有」单独说;其余交给通用那一句。 */
export function isExistsError(error: unknown): boolean {
  return errorCode(error) === WORKSPACE_EXISTS_CODE;
}
