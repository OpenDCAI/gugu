// #6264 别的桌面经「设备连接」用这台机器的会话页宿主(behavior gugu-server.md 第 8 条:别的机器上的会话与本机
// 同一套界面与能力,只差请求走哪条线;照 VS Code Agent Host —— 本机进程内 IPC,远端同一套协议走一条连接)。
//
// 线 = 设备 RPC(远程 SSH 的机器走 `gugu-server link`,远程隧道的机器走咕咕云频道;两条线同一张处理表,
// 见 server/device-link-host.ts)。三个动词 + 一种推送:
//   taskhost.open  {client, desktop?}           开一条「窗口」(FrameSessionHost 上的一个 sender);desktop = 桌面报的版本
//   taskhost.frame {client, seq, frames[]}      桌面 → 这台机器的帧(按 seq 排好再交出去)
//   taskhost.close {client}
//   推送 {type: 'taskhost.frame', client, seq, frames[]}   这台机器 → 那台桌面
// 帧就是会话页宿主协议(host-ws-protocol)的帧,装进 JSON 信封(frameToCarrier);超过 PIECE_CHARS 的帧分片。
//
// 成本:每条连接双向各一拍心跳(20s);一条帧的往返 = 一次设备 RPC(同一微任务里的帧合成一条)。
import { FILE_PATCH_PROTOCOL, protocol13FileChanges } from '@gugu/session-core/session-record/contract';
import {
  createPieceJoiner,
  createSeqOrderer,
  SESSION_HOST_FRAME_EVENT,
  SESSION_HOST_RPC,
  toPieces,
  type SessionHostFrameBatch,
  type SessionHostPiece,
} from '@shared/lib/ipc/session-host-device-frames';
import type { DeviceRpcAskerContext, DeviceRpcHandlers, PublishDeviceRpcEvent } from '@gugu/core/cloud/deviceRpcResponder';
import {
  DESKTOP_REPORT_REFRESH_MS,
  noteDesktopHello,
  parseDesktopHello,
  requestVersionRetry,
  VERSION_RETRY_RPC,
  type DesktopHello,
} from '@gugu/core/cloud/serverDesktopVersions';
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth';
import { SESSIONPAGE_PLATFORM_CATALOG_CHANNEL, SESSIONPAGE_PLATFORM_RETRY_CHANNEL } from '@shared/core/agents/platform-model';
import { SESSIONPAGE_SESSION_RELOAD_CHANNEL } from '@shared/core/agents/session-reload';
import { SESSION_SHELL_CHANNELS } from '@shared/lib/ipc/shell-port';
import { serializeHostWsError } from '@shared/lib/ipc/host-ws-protocol';
import { log } from '../lib/logger';
import { FrameSessionHost, type FrameInvokePolicy, type FrameSocket } from './frame-host';
import { createRemotePtyPacer } from './remote-pty-pacer';
import { ptySessionRegistry } from '../core/pty/pty-session-registry';

/**
 * 别的电脑连进来时不给的:属于「看界面的那台电脑」的动作(窗口、剪贴板、对话框、内置浏览器、界面布局记忆),
 * 以及只在桌面那一侧才有意义的 SSH 直连 / 端口转发。挡在这里还有一层用处:渲染层把本该留在本机的调用
 * 错发过来时,当场报错而不是悄悄在这台机器上执行。
 */
const REMOTE_DENIED_NAMESPACES = new Set(['browser', 'remotePorts', 'viewState']);
const REMOTE_ALLOWED_APP = new Set([
  'app.getAppVersion',
  'app.getPlatform',
  'app.getHomeDirectory',
  // 那台机器的任务工作区目录(#609 别的电脑在那台上开不选文件夹的任务;从前这里写的 getTaskHomeDir 早没有这条)。
  'app.getSessionHomeDir',
  'app.getElectronVersion',
  'app.readUserFile',
  'app.readUserImageDataUrl',
  // The assistant's books belong to this host and signed-in owner, including when read on a phone.
  'app.getUserLibrary',
  'app.getUserLibraryVolume',
  'app.readUserLibraryEntry',
  'app.writeUserLibraryEntry',
]);
const REMOTE_DENIED_EXTENSIONS = /^extensions\.(bindSurface|retargetSurface|invokeCommand|reportLayout|setAppState|programNotifiedElsewhere)$/;
/** 屏上有哪些会话:那台桌面的屏,❌ 盖掉这台机器自己报的(闲置回收读它,见 core/sessions/sessions-on-screen.ts)。 */
const REMOTE_DENIED_CHANNELS = new Set(['sessions.reportSessionsOnScreen']);

export const remoteInvokePolicy: FrameInvokePolicy = (channel) => {
  const namespace = channel.split('.', 1)[0] ?? '';
  if (REMOTE_DENIED_NAMESPACES.has(namespace) || REMOTE_DENIED_CHANNELS.has(channel)) return false;
  if (namespace === 'app') return REMOTE_ALLOWED_APP.has(channel);
  return !REMOTE_DENIED_EXTENSIONS.test(channel);
};

/** Read recovery entries, or explicitly clear them, from an owner-bound remote App page.
 * This is not a grant to the whole App dispatcher. The handler additionally checks the
 * expected owner against its current authenticated account before reading or writing. */
export function remoteInvokePolicyForCaller(callerId: string | undefined): FrameInvokePolicy {
  return (channel, args) => {
    if (channel !== 'app.assistantAppCall') return remoteInvokePolicy(channel, args);
    if (!callerId || args?.length !== 3 || args[0] !== 'callProgram' || args[2] !== callerId) return false;
    const input = args[1];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const operation = input as Record<string, unknown>;
    if (Object.keys(operation).some(key => !['name', 'arguments', 'server'].includes(key))) return false;
    if (operation.server !== undefined && operation.server !== 'resources') return false;
    if (operation.arguments !== undefined && (!operation.arguments || typeof operation.arguments !== 'object'
      || Array.isArray(operation.arguments) || Object.keys(operation.arguments).length !== 0)) return false;
    return operation.name === 'assistant_work_list' || operation.name === 'assistant_work_clear';
  };
}

let installed: FrameSessionHost | null = null;

type HostHandler = (event: unknown, ...args: unknown[]) => unknown;

/**
 * 咕咕壳主进程里那几条别的电脑也要问的 handler(平台模型目录、会话重载、会话身份口 —— 它们看的是这台机器
 * 上的会话与登录态)。只放这张单子里的:分享名片、报障、启动失败这类是看界面那台电脑的事。
 */
export const REMOTE_SHELL_CHANNELS: ReadonlySet<string> = new Set([
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  SESSIONPAGE_PLATFORM_RETRY_CHANNEL,
  SESSIONPAGE_SESSION_RELOAD_CHANNEL,
  SESSION_SHELL_CHANNELS.agentCard,
  SESSION_SHELL_CHANNELS.agentNames,
  SESSION_SHELL_CHANNELS.renameAgent,
  SESSION_SHELL_CHANNELS.ensureAgentAddress,
  SESSION_SHELL_CHANNELS.sessionPeers,
]);

let shellLookup: ((channel: string) => HostHandler | undefined) | null = null;

/** 别的设备能问的那几条壳口(远端桌面经窗口问、手机经设备 RPC 问,同一个 handler)。 */
export function remoteShellHandler(channel: string): HostHandler | undefined {
  return REMOTE_SHELL_CHANNELS.has(channel) ? shellLookup?.(channel) : undefined;
}

/** 主进程把自己记下的 handler 交过来(main.ts 启动时调)。 */
export function setDeviceSessionHostShellHandlers(lookup: ((channel: string) => HostHandler | undefined) | null): void {
  shellLookup = lookup;
  installed?.setFallback(lookup ? (channel) => remoteShellHandler(channel) as ((...args: unknown[]) => unknown) | undefined : null);
}

/**
 * 壳主进程播给界面的那几条(会话开户 / agent 改名)也推给经设备连接看着这台机器的别的电脑 ——
 * 本机窗口是 webContents.send,别的电脑只能从这里收到;❌ 只播本机窗口,远端会话的身份卡就永远等不到它。
 * 没装 / 没人连着 = 无事。
 */
export function broadcastDeviceSessionHostEvent(channel: string, data: unknown): void {
  installed?.broadcast(channel, data);
}

/** boot 时装一份(compose 进 hostIpc)。没装 = 这台机器不接别的桌面(taskhost.open 报 unavailable)。 */
export function installDeviceSessionHost(options: { appVersion: () => string }): FrameSessionHost {
  installed ??= new FrameSessionHost({ appVersion: options.appVersion, label: 'session-host-device' });
  return installed;
}

type ClientLink = {
  receive: (seq: number, pieces: SessionHostPiece[]) => void;
  close: (reason?: string) => void;
};

/**
 * #6264 桌面开窗口时报「我是哪一版」(咕咕 server 上记进这个账号的数据目录,守护进程据此让这个账号跑匹配的版本,
 * 见 core/cloud/serverDesktopVersions.ts)。窗口开着时每小时续报一次:一直连着的桌面 ❌ 因为报告过期被当成不在了。
 * 桌面自己(非 server)什么也不记。记不下来 ❌ 挡开窗口 —— 那只影响「跑哪一版」,不影响这次连接。
 */
function reportDesktop(hello: DesktopHello | null): () => void {
  if (!hello) return () => undefined;
  const note = () => {
    try {
      const noted = noteDesktopHello(process.env, hello);
      if (noted.switchRequested) log.info('[session-host-device] desktop protocol outside window, version switch requested', { desktop: hello.id, version: hello.version, protocol: hello.protocol });
    } catch (error) {
      log.warn('[session-host-device] desktop version not recorded', { error: String(error) });
    }
  };
  note();
  let last = Date.now();
  return () => {
    if (Date.now() - last < DESKTOP_REPORT_REFRESH_MS) return;
    last = Date.now();
    note();
  };
}

/**
 * 每条设备 RPC 频道一份(与 createSessionpageSessionDeviceRpcHandlers 同一条「按频道建、按频道拆」):
 * 频道没了,经它开的窗口一起收掉。
 */
export function createSessionHostDeviceRpcHandlers(options: { host?: () => FrameSessionHost | null } = {}): {
  handlers: DeviceRpcHandlers;
  dispose: () => void;
} {
  const host = options.host ?? (() => installed);
  const clients = new Map<string, ClientLink>();

  const openClient = (
    client: string,
    publish: PublishDeviceRpcEvent,
    frameHost: FrameSessionHost,
    desktop: DesktopHello | null,
    asker: DeviceRpcAskerContext | undefined,
    callerId: string | undefined,
    peerProtocol: number | undefined,
  ): void => {
    clients.get(client)?.close('replaced');
    const refreshReport = reportDesktop(desktop);
    let frameCb: ((frame: string | Uint8Array) => void) | null = null;
    let closeCb: (() => void) | null = null;
    let closed = false;
    let outSeq = 0;
    let outbox: (string | Uint8Array)[] = [];
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      const frames = outbox;
      outbox = [];
      for (const pieces of toPieces(frames)) {
        const batch: SessionHostFrameBatch = { client, seq: outSeq++, frames: pieces };
        void Promise.resolve(publish({ type: SESSION_HOST_FRAME_EVENT, ...batch })).catch((error: unknown) =>
          log.warn('[session-host-device] push failed', { client, error: String(error) })
        );
      }
    };
    const joiner = createPieceJoiner((frame) => frameCb?.(frame));
    const order = createSeqOrderer<SessionHostPiece[]>(joiner);
    const socket: FrameSocket = {
      send: (frame) => {
        if (closed) return;
        outbox.push(frame);
        if (!flushScheduled) {
          flushScheduled = true;
          queueMicrotask(flush);
        }
      },
      close: (reason) => shut(reason),
      onFrame: (cb) => (frameCb = cb),
      onClose: (cb) => (closeCb = cb),
    };
    const shut = (reason = 'client close') => {
      if (closed) return;
      closed = true;
      log.warn('[session-host-device] client closed', { client, reason });
      stopWatchingAsker?.();
      if (clients.get(client) === link) clients.delete(client);
      closeCb?.();
    };
    // #7233 开它的发问端那条线没了(宿主空闲关 / 让位 / 收摊):帧推不过去了,窗口一并关掉;发问端重新报到后会重开一条。
    const stopWatchingAsker = asker?.onDetached(() => shut('asker detached'));
    const link: ClientLink = {
      receive: (seq, pieces) => {
        refreshReport();
        order(seq, pieces);
      },
      close: shut,
    };
    clients.set(client, link);
    // 开与关成对落盘(关那句在 shut 里),两头的日志才对得上是哪一条窗口(桌面那头按同一个 client 记,remoteSessionHost)。
    // 用 warn 是因为会话进程默认只落 warn 及以上(@gugu/session-shared/logger 的 resolveLogLevel):frame-host 那句
    // info 的「client connected」在用户机器上落不了盘,2026-10-27 d22 上就只剩关、没有开。一条窗口一行,❌ 按帧记。
    log.warn('[session-host-device] client opened', { client, desktop: desktop?.id ?? null });
    frameHost.attach(socket, {
      remote: `device:${client.slice(0, 8)}`,
      policy: remoteInvokePolicyForCaller(callerId),
      outgoing: createRemotePtyPacer({ screenSnapshot: (id) => ptySessionRegistry.screenSnapshot(id) }),
      ...(peerProtocol !== undefined ? { peerProtocol } : {}),
    });
  };
  const readClient = (payload: unknown): string | null => {
    const client = (payload as { client?: unknown } | null)?.client;
    return typeof client === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(client) ? client : null;
  };

  const handlers: DeviceRpcHandlers = {
    [SESSION_HOST_RPC.open]: (payload, ctx) => {
      const client = readClient(payload);
      if (!client) return { error: { code: 'invalid_payload', message: 'client 是必填的' } };
      const frameHost = host();
      if (!frameHost) return { error: { code: 'unavailable', message: 'session host is not running on this machine' } };
      const desktop = parseDesktopHello((payload as { desktop?: unknown }).desktop);
      // 开窗口的一方说的协议:手机与桌面都报 `protocol`;只有桌面另报 `desktop`(咕咕 server 据此挑跑哪一版,手机不算)。
      const said = (payload as { protocol?: unknown }).protocol;
      const protocol = typeof said === 'number' ? said : desktop?.protocol;
      // 比 MIN_CLIENT_PROTOCOL 旧的一方开窗口,只会在某个动作上半截失败:当场拒并说清。
      // 咕咕 server 上照样先记下桌面的版本 —— 守护进程据此换成匹配的那一版,换完它就开得了。不报协议的不下结论。
      // 它会一遍遍来开:记着的已是同一件事就不再写(noteDesktopHello)。
      if (protocol != null && protocol < MIN_CLIENT_PROTOCOL) {
        reportDesktop(desktop);
        return {
          error: {
            code: 'client_outdated',
            message: `Gugu on the device opening this is too old (protocol ${protocol}, this machine needs ${MIN_CLIENT_PROTOCOL}): update Gugu there`,
          },
        };
      }
      openClient(client, ctx.publishEvent, frameHost, desktop, ctx.asker, ctx.request?.user_id, protocol ?? undefined);
      return { result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } };
    },
    [SESSION_HOST_RPC.frame]: (payload) => {
      const client = readClient(payload);
      const body = payload as Partial<SessionHostFrameBatch> | null;
      if (!client || typeof body?.seq !== 'number' || !Array.isArray(body.frames)) {
        return { error: { code: 'invalid_payload', message: 'client / seq / frames 是必填的' } };
      }
      const link = clients.get(client);
      // 这台机器已经不认这条窗口(重启过 / 频道换过):让桌面那边重开一条,❌ 静默吞帧。
      if (!link) return { error: { code: 'not_open', message: 'session host window is not open' } };
      link.receive(body.seq, body.frames);
      return { result: { ok: true } };
    },
    [SESSION_HOST_RPC.call]: async (payload, ctx) => {
      const frameHost = host();
      if (!frameHost) return { error: { code: 'unavailable', message: 'session host is not running on this machine' } };
      const body = (payload ?? {}) as { channel?: unknown; args?: unknown; protocol?: unknown };
      if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
        return { error: { code: 'invalid_payload', message: 'channel 与 args 是必填的' } };
      }
      try {
        const value = (await frameHost.invokeOnce(body.channel, body.args, remoteInvokePolicyForCaller(ctx.request?.user_id))) ?? null;
        // A caller before protocol 14 never said its protocol here: absent = older (protocol13FileChanges, delete on next bump).
        const peer = typeof body.protocol === 'number' ? body.protocol : FILE_PATCH_PROTOCOL - 1;
        return { result: { value: protocol13FileChanges(value, peer, 'to-peer'), protocol: REMOTE_PROTOCOL_VERSION } };
      } catch (error) {
        const failed = serializeHostWsError(error);
        return { error: { code: failed.code ?? 'call_failed', message: failed.message } };
      }
    },
    // #6264 设备行「更新没成功 · 重试」:请守护进程不看冷却、再试一次换成和桌面匹配的那一版。
    [VERSION_RETRY_RPC]: () =>
      requestVersionRetry(process.env)
        ? { result: { requested: true } }
        : { error: { code: 'unavailable', message: 'not a gugu server' } },
    [SESSION_HOST_RPC.close]: (payload) => {
      const client = readClient(payload);
      if (client) clients.get(client)?.close();
      return { result: { closed: true } };
    },
  };

  return {
    handlers,
    dispose: () => {
      for (const link of [...clients.values()]) link.close('handler disposed');
      clients.clear();
    },
  };
}
