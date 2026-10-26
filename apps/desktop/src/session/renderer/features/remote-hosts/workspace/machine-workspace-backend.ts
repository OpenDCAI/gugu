// #6264 一套工作台:别的机器上的项目,会话右侧工作区的后端。
//
// 照 VS Code Remote:工作台只有一个。文件、文件树、编辑器、审阅、git、终端走的是与本机**同一套** `rpc.workspace` /
// `rpc.terminals` / `rpc.pty` 动词 —— rpc 按项目所在的机器把调用送过去(lib/machine-routing.ts),这里不再翻译。
// 剩下的只有「这台电脑与那台机器之间」才有的几件事:
//  · 预览:`gugu-preview://` 的登记表在这台电脑,字节按块从那台机器取(preview-protocol.ts + readChunk);
//  · 文件树:从访达拖进来 / 上传 / 下载(字节要过线,分块、有进度,remote-transfers.ts);
//  · 浏览器:`localhost:N` 指那台机器上的 N 端口,经 SSH 转过来再加载;`file:` 网页从那台机器取;
//  · 哪几格给:只经咕咕云连着的机器没有终端、浏览器、端口(网页与终端流量 ❌ 塞进云端消息通道)。
import { computed, makeObservable, observable, runInAction } from 'mobx';
import { err, ok } from '@gugu/session-shared';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import type { BrowserUrlResolver } from '@renderer/features/browser/browser-url-resolver';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { localWorkspaceBackend } from '@renderer/features/sessions/workspace-backend/local-workspace-backend';
import type { WorkspaceBrowserAttachment, WorkspaceBrowserBackend } from '@renderer/features/sessions/workspace-backend/workspace-browser-backend';
import {
  registerWorkspaceBackend,
  workspaceEvents,
  type WorkspaceBackend,
  type WorkspaceRpc,
} from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { setWorkspaceReachResolver } from '@renderer/features/sessions/workspace-backend/workspace-surface';
import type { WorkspaceTreeBackend, WorkspaceTreeScope } from '@renderer/features/sessions/workspace-backend/workspace-tree-backend';
import { events, onMachineEvent, rpc, rpcOn } from '@renderer/lib/ipc';
import type { EventDefinition } from '@shared/lib/ipc/events';
import { fileChangesChannel, fileTreeProjectionChannel } from '@shared/core/fs/fsEvents';
import { gitRepoUpdateChannel, gitWorktreeUpdateChannel } from '@shared/core/git/events';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { remotePortKey, remotePortLinkChannel, type RemotePortLink, type RemotePortReason } from '@shared/remote-port-link';
import type { SshPrompt } from '@shared/ssh-prompt';
import { remoteErrorCode } from '../remote-failure-copy';
import { hostStatusLabel, machineNoticeLabel } from '../connection-status';
import { remoteHostsStore } from '../remote-hosts-store';
import { downloadEntry, uploadItems } from './remote-file-actions';
import { dropUploadItems, fileUploadItem } from './remote-drop-items';
import { remoteForLocalPort, watchRemoteForwards } from './remote-forward-cache';
import { remotePageFailureCopy, remotePortFailureText } from './remote-page-copy';
import { RemotePageSession } from './remote-page-session';
import { transfersFor } from './remote-transfer-wiring';
import {
  forwardedUrl,
  presentForwardedUrl,
  remoteLoopbackPort,
  remoteToolReach,
  remoteWorkspaceFailure,
  remoteWorkspaceTools,
} from './remote-workspace-routing';

function deviceLabel(deviceId: string): string {
  return remoteHostsStore.device(deviceId)?.label ?? deviceId;
}

function hasTool(deviceId: string, tool: 'terminal' | 'browser' | 'ports'): boolean {
  return remoteWorkspaceTools(remoteHostsStore.device(deviceId) ?? null).includes(tool);
}

/** 这个项目在哪台别的机器上(本机 = null)。 */
export function machineOfProject(projectId: string): string | null {
  return machineRegistry.machineOf(projectId);
}

// ── 动词:与本机同一套,只有预览登记留在这台电脑 ──────────────────────────────────

function machineRpc(deviceId: string): WorkspaceRpc {
  const files = new Proxy(rpc.workspace.files, {
    get(target, verb, receiver) {
      if (verb !== 'createPreview') return Reflect.get(target, verb, receiver);
      // HTML 预览:登记在这台电脑的 `gugu-preview://`,字节按块从那台机器取(相对资源照常加载;路径由那台机器核)。
      const createPreview: WorkspaceRpc['files']['createPreview'] = async (projectId, workspaceId, filePath, documentHtml) => {
        const [root, doc] = await Promise.all([
          rpc.workspace.files.getAbsolutePath(projectId, workspaceId, '.'),
          rpc.workspace.files.getAbsolutePath(projectId, workspaceId, filePath),
        ]);
        const unavailable = err({
          type: 'fs_error' as const,
          message: translateSessionMessage('remoteWorkspace.pageUnavailable', { device: deviceLabel(deviceId) }),
        });
        if (!root.success || !doc.success) {
          // 人看到的只是一句「没能打开」—— 那台机器拒绝的原文进日志,❌ 吞掉(否则只能靠复现去猜是哪一步)。
          log.warn('[machine-preview] workspace path unavailable', {
            deviceId,
            filePath,
            root: root.success ? 'ok' : root.error,
            document: doc.success ? 'ok' : doc.error,
          });
          return unavailable;
        }
        const result = await rpc.workspace.files.createRemotePreview({
          projectId,
          workspaceId,
          root: root.data.path,
          surface: 'pane',
          documentPath: doc.data.path,
          documentHtml,
          failureCopy: remotePageFailureCopy(deviceLabel(deviceId)),
        });
        return result.success && result.data.url ? ok({ previewId: result.data.previewId, url: result.data.url }) : unavailable;
      };
      return createPreview;
    },
  });
  // rpc 客户端是代理(命名空间现取),❌ 展开复制;同样用代理只换 files 那一格。
  return new Proxy(rpc.workspace, {
    get: (target, ns, receiver) => (ns === 'files' ? files : Reflect.get(target, ns, receiver)),
  }) as WorkspaceRpc;
}

// ── 文件树:增删改名与本机同一套;拖进来 / 上传 / 下载要把字节搬过线 ──────────────────

function machineTree(deviceId: string): WorkspaceTreeBackend {
  const describe = (error: unknown) => remoteWorkspaceFailure(error, deviceLabel(deviceId), translateSessionMessage);
  const transfers = (scope: WorkspaceTreeScope) => transfersFor(deviceId, scope.projectId, scope.workspaceId);
  const upload = async (scope: WorkspaceTreeScope, dir: string, items: Parameters<typeof uploadItems>[2]) => {
    const done = await uploadItems(transfers(scope), dir, items, deviceLabel(deviceId), describe);
    // 树里马上看得见(文件监视也会推,但这里不等它)。
    if (done) await scope.files?.registerDir(dir, true);
  };
  return {
    ...localWorkspaceBackend.tree,
    // 「在访达中显示」对别的机器上的文件没有意义 —— 换成「下载…」。
    canReveal: false,
    importDropped(scope, dir, dataTransfer) {
      // 必须在这一拍里把拖进来的东西取出来(浏览器在事件结束后就收回 dataTransfer)。
      const pending = dropUploadItems(dataTransfer);
      return pending.then((items) => upload(scope, dir, items));
    },
    uploadFiles(scope, dir, files) {
      return upload(scope, dir, files.map((file) => fileUploadItem(file)));
    },
    download(scope, entry) {
      return downloadEntry(
        transfers(scope),
        { name: entry.name, path: entry.path, isDirectory: entry.kind === 'directory', size: entry.size ?? 0 }
      );
    },
    transfers: (scope) => transfers(scope).active,
  };
}

// ── 浏览器:localhost 转到那台机器,`file:` 从那台机器取 ─────────────────────────────

class MachineBrowserAttachment implements WorkspaceBrowserAttachment {
  /** 正在转的那个端口此刻等人回答的问题。 */
  private pending: { port: number; prompt: SshPrompt } | null = null;
  /** 这一格持有的转发:远端端口 → 转到的本机端口。 */
  private readonly forwards = new Map<number, number>();
  private readonly offLinks = new Map<number, () => void>();
  private readonly pages: RemotePageSession;
  private readonly stopForwardCache: () => void;

  constructor(
    private readonly browserId: string,
    private readonly deviceId: string,
    private readonly ctx: SessionTabContext
  ) {
    makeObservable<MachineBrowserAttachment, 'pending'>(this, { pending: observable.ref, prompt: computed });
    this.pages = new RemotePageSession({
      root: async () => {
        if (ctx.workspacePath) return ctx.workspacePath;
        const result = await rpc.workspace.files.getAbsolutePath(ctx.projectId, ctx.workspaceId, '.');
        if (!result.success) throw new Error('workspace root unavailable');
        return result.data.path;
      },
      register: async (root) => {
        const result = await rpc.workspace.files.createRemotePreview({
          projectId: ctx.projectId,
          workspaceId: ctx.workspaceId,
          root,
          surface: 'browser',
          failureCopy: remotePageFailureCopy(deviceLabel(deviceId)),
        });
        return result.success ? result.data.previewId : null;
      },
      release: (previewId) => void rpc.workspace.files.releasePreview(previewId).catch(() => undefined),
      log: (message, fields) => log.warn(`[machine-browser] ${message}`, { deviceId, ...fields }),
    });
    // 地址栏显示人要开的 `file:///…` / `localhost:<那台机器上的端口>`,❌ 页签实际加载的那串内部地址。
    browserSessionStore.setUrlPresenter(
      browserId,
      (url) => this.pages.present(url) ?? presentForwardedUrl(url, (local) => this.remoteForLocal(local))
    );
    this.stopForwardCache = watchRemoteForwards(deviceId);
    // 页面自己发的 localhost 请求(前端调后端的另一个端口、跳转)也到那台机器(主进程 remote-loopback-requests.ts)。
    void rpc.remotePorts.bindBrowser({ browserId, deviceId, sessionId: ctx.sessionId }).catch(() => undefined);
  }

  /** ssh 为了转发端口在问人:问题本身 + 卡片第一行(哪台机器、为哪个端口)。 */
  get prompt(): { context: { name: string; detail: string }; prompt: SshPrompt } | null {
    const pending = this.pending;
    if (!pending) return null;
    return {
      context: { name: deviceLabel(this.deviceId), detail: translateSessionMessage('remoteWorkspace.forwardDetail', { port: pending.port }) },
      prompt: pending.prompt,
    };
  }

  private remoteForLocal(localPort: number): number | null {
    for (const [remote, local] of this.forwards) if (local === localPort) return remote;
    return remoteForLocalPort(this.deviceId, localPort);
  }

  private async resolvePage(url: string): Promise<{ url: string } | { error: string }> {
    const resolved = await this.pages.resolve(url);
    if ('url' in resolved) return resolved;
    return {
      error: translateSessionMessage(resolved.error === 'outside' ? 'remoteWorkspace.pageOutsideFolder' : 'remoteWorkspace.pageUnavailable', {
        device: deviceLabel(this.deviceId),
      }),
    };
  }

  private watchPort(port: number): void {
    if (this.offLinks.has(port)) return;
    const off = events.on(
      remotePortLinkChannel,
      (link: RemotePortLink) => {
        runInAction(() => {
          if (link.prompt) this.pending = { port, prompt: link.prompt };
          else if (this.pending?.port === port) this.pending = null;
        });
      },
      remotePortKey(this.deviceId, port)
    );
    this.offLinks.set(port, off);
  }

  /** 加载前的改写:`file:` 从那台机器取;localhost 的端口先经 SSH 转过去(照 VS Code 端口转发)。 */
  readonly resolve: BrowserUrlResolver = async (url, browserId) => {
    if (url.startsWith('file:')) return this.resolvePage(url);
    const typed = remoteLoopbackPort(url);
    if (typed === null) return { url };
    // 地址栏里是已经转好的本机端口(重新加载、回车):按它对应的远端端口再确认一次转发还在。
    let remotePort = typed;
    if (new URL(url).hostname === '127.0.0.1') remotePort = this.remoteForLocal(typed) ?? typed;
    this.watchPort(remotePort);
    const result = await rpc.remotePorts.open({ deviceId: this.deviceId, sessionId: this.ctx.sessionId, remotePort, holder: browserId });
    runInAction(() => {
      if (this.pending?.port === remotePort) this.pending = null;
    });
    if (result.success) {
      this.forwards.set(remotePort, result.data.localPort);
      return { url: forwardedUrl(url, result.data.localPort) };
    }
    const reason: RemotePortReason = result.error.type === 'failed' ? result.error.reason : 'unknown';
    log.warn('[machine-browser] 端口转发没成', { deviceId: this.deviceId, remotePort, reason });
    return { error: remotePortFailureText(reason, remotePort, deviceLabel(this.deviceId), translateSessionMessage) };
  };

  answer(value: string | null, extra?: { installKey?: boolean }): void {
    const current = this.pending;
    if (!current) return;
    void rpc.remotePorts
      .answerPrompt({
        deviceId: this.deviceId,
        remotePort: current.port,
        promptId: current.prompt.id,
        value,
        installKey: extra?.installKey === true,
      })
      .catch(() => undefined);
  }

  dispose(): void {
    // 不再代它转;页面里顺带要过的端口(主进程替它持有的)一并放手。
    void rpc.remotePorts.unbindBrowser({ browserId: this.browserId }).catch(() => undefined);
    this.stopForwardCache();
    for (const [remotePort, off] of this.offLinks) {
      off();
      void rpc.remotePorts.release({ deviceId: this.deviceId, remotePort, holder: this.browserId }).catch(() => undefined);
    }
    this.offLinks.clear();
    this.pages.dispose();
    browserSessionStore.setUrlPresenter(this.browserId, null);
  }
}

function machineBrowser(deviceId: string): WorkspaceBrowserBackend {
  return {
    get available() {
      return hasTool(deviceId, 'browser');
    },
    // 转发活不过应用重启:页签 ❌ 从快照里复活(复活了地址栏里是一个已经没人监听的本机端口)。
    persistent: false,
    attach: (browserId: string, ctx: SessionTabContext) => new MachineBrowserAttachment(browserId, deviceId, ctx),
  };
}

// ── 登记 ──────────────────────────────────────────────────────────────────────

const backends = new Map<string, WorkspaceBackend>();

function backendFor(deviceId: string): WorkspaceBackend {
  let found = backends.get(deviceId);
  if (!found) {
    found = {
      machine: { kind: 'remote', deviceId, label: () => deviceLabel(deviceId) },
      rpc: machineRpc(deviceId),
      browseDirectory: (_workspaceId, path) => rpcOn(deviceId).files.browseDirectory({ type: 'local', path }),
      tree: machineTree(deviceId),
      browser: machineBrowser(deviceId),
      // 终端与本机同一套(那台机器上的 pty,经 rpc 路由过去);只经咕咕云连着的机器不给(❌ 走消息额度)。
      terminal: {
        ...localWorkspaceBackend.terminal,
        get available() {
          return hasTool(deviceId, 'terminal');
        },
        terminals: (ctx) => (hasTool(deviceId, 'terminal') ? localWorkspaceBackend.terminal.terminals(ctx) : null),
      },
      async setGitIdentity(_workspaceId, identity) {
        try {
          const result = await rpcOn(deviceId).machine.setGitIdentity(identity);
          if (result.success) return { ok: true };
          log.error('[session/vcs] set remote git identity failed', { deviceId, code: result.error.type });
        } catch (error) {
          const code = remoteErrorCode(error);
          log.error('[session/vcs] set remote git identity failed', { deviceId, code });
          if (code === 'unknown_method') {
            return { ok: false, message: translateSessionMessage('remoteWorkspace.identity.tooOld', { device: deviceLabel(deviceId) }) };
          }
        }
        return { ok: false, message: translateSessionMessage('remoteWorkspace.identity.failed', { device: deviceLabel(deviceId) }) };
      },
    };
    backends.set(deviceId, found);
    // 工作区的事件(文件变了 / 文件树投影 / git 状态)在那台机器上订,由这里在渲染层发出(workspace-backend.ts 抬头):
    // 用到那台机器上的工作区时才有这份后端,所以只有打开着的远程项目才收它的文件与 git 推送。
    for (const event of [fileChangesChannel, fileTreeProjectionChannel, gitWorktreeUpdateChannel, gitRepoUpdateChannel] as EventDefinition<unknown>[]) {
      onMachineEvent(deviceId, event, (data) => workspaceEvents.emit(event, data));
    }
  }
  return found;
}

let installed = false;

/** 装一次(启动时):别的机器上的项目都走这里。 */
export function ensureMachineWorkspaceBackend(): void {
  if (installed) return;
  installed = true;
  registerWorkspaceBackend((projectId) => {
    const deviceId = machineOfProject(projectId);
    return deviceId ? backendFor(deviceId) : null;
  });
  // 那台机器此刻够不着:工作区各格照样在,只是说「离线,上次在线 X」(与侧栏同一句);连回来之后自己接上。
  setWorkspaceReachResolver((projectId) => {
    const deviceId = machineOfProject(projectId);
    if (!deviceId) return null;
    const device = remoteHostsStore.device(deviceId);
    const versionNotice = machineNoticeLabel(device?.notices, deviceLabel(deviceId), translateSessionMessage, { protocolOnly: true });
    if (versionNotice) return versionNotice;
    const state = remoteHostsStore.connectionState(deviceId);
    if (state === 'connected' || state === 'connecting') return null;
    // Older desktops report their protocol when opening the link, without heartbeat notices.
    if (state === 'outdated') return hostStatusLabel(state, deviceLabel(deviceId), device?.lastSeenAt, Date.now(), translateSessionMessage);
    const reach = remoteToolReach(remoteHostsStore.device(deviceId) ?? null, Date.now(), translateSessionMessage);
    return reach.ok ? translateSessionMessage('remoteWorkspace.noAnswer', { device: deviceLabel(deviceId) }) : reach.label;
  });
}
