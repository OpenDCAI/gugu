/**
 * #6264 别的机器上会话的「浏览器」页签里,页面自己发出的 localhost 请求(前端 :5173 调后端 :8000、跳转、重定向、
 * WebSocket)也要到**那台机器**,❌ 打到这台电脑自己的端口上。照 VS Code:它把用到的端口都转过来且尽量同号
 * (autoForwardPorts + 集成浏览器的 remote proxy),页面里写死的 `http://localhost:8000` 于是照样通。
 *
 * 做法:浏览器分区上挂一个只看回环地址的 onBeforeRequest。请求来自一个绑定了机器的页签时:
 *  · 端口已经是这台机器某条转发的本机那一头 ⇒ 放行;
 *  · 否则当它是那台机器上的端口 ⇒ 先转过来(优先同号),同号就原样放行,不同号就改写到本机那个端口;
 *  · 转不过来 ⇒ 拦掉(❌ 放它打到这台电脑上同号的某个别的服务)。
 * 不是远端页签发的请求(本机浏览器页签)一概不碰。代价:只有回环地址的请求进这个回调,一次 Map 查找;
 * 第一次用到某个端口时起一条 SSH 转发(之后复用)。
 */
import type { Session } from 'electron';

export type RemoteBrowserBinding = { deviceId: string; sessionId: string };

const bindings = new Map<string, RemoteBrowserBinding>();

export function bindRemoteBrowser(browserId: string, binding: RemoteBrowserBinding): void {
  bindings.set(browserId, binding);
}

export function unbindRemoteBrowser(browserId: string): void {
  bindings.delete(browserId);
}

export function remoteBrowserBinding(browserId: string): RemoteBrowserBinding | null {
  return bindings.get(browserId) ?? null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** 这条请求指向的回环端口(不是回环地址 ⇒ null)。 */
export function loopbackPortOf(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') return 80;
  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') return 443;
  return null;
}

export type LoopbackDecision = { pass: true } | { redirect: string } | { cancel: true };

export type LoopbackDeps = {
  binding: (browserId: string) => RemoteBrowserBinding | null;
  browserIdFor: (webContentsId: number) => string | null;
  /** 这台电脑上的这个端口是不是这台机器某条转发的本机那一头;是 ⇒ 远端端口。 */
  remoteForLocal: (deviceId: string, localPort: number) => number | null;
  /** 转过来(已经转好就直接给):本机端口;转不成抛错。 */
  open: (input: { deviceId: string; sessionId: string; remotePort: number; holder: string }) => Promise<number>;
  status: (deviceId: string, remotePort: number) => { phase: string; localPort: number | null } | null;
};

export async function decideLoopbackRequest(
  details: { url: string; webContentsId?: number },
  deps: LoopbackDeps
): Promise<LoopbackDecision> {
  const port = loopbackPortOf(details.url);
  if (port === null || details.webContentsId === undefined) return { pass: true };
  const browserId = deps.browserIdFor(details.webContentsId);
  const binding = browserId ? deps.binding(browserId) : null;
  if (!browserId || !binding) return { pass: true };
  // 只有 `127.0.0.1:<转发的本机端口>` 才是那台机器:ssh 只绑在 127.0.0.1 上。`localhost` / `[::1]` / `0.0.0.0`
  // 可能被解析到 ::1、落到这台电脑上只听 IPv6 的别的服务(2026-09-24 实撞),所以一律改写成 127.0.0.1。
  const exact = new URL(details.url).hostname === '127.0.0.1';
  // 本机那一头、而且活着:页面自己的来源(页签加载的就是这个地址)。
  const mapped = deps.remoteForLocal(binding.deviceId, port);
  if (mapped !== null) {
    const link = deps.status(binding.deviceId, mapped);
    if (link?.phase === 'ready' && link.localPort === port) return exact ? { pass: true } : { redirect: rewrite(details.url, port) };
  }
  const remotePort = mapped ?? port;
  let localPort: number;
  try {
    localPort = await deps.open({ ...binding, remotePort, holder: browserId });
  } catch {
    // ❌ 放行:放行就是打到这台电脑自己的同号端口上。
    return { cancel: true };
  }
  if (exact && localPort === port) return { pass: true };
  return { redirect: rewrite(details.url, localPort) };
}

/** 改写到转发在这台电脑上的确切地址(127.0.0.1)。WebSocket 等协议原样保留。 */
function rewrite(url: string, localPort: number): string {
  const rewritten = new URL(url);
  rewritten.hostname = '127.0.0.1';
  rewritten.port = String(localPort);
  return rewritten.toString();
}

/** 回环地址(match pattern 不看端口,所以每个端口都进来)。 */
export const LOOPBACK_URL_PATTERNS = ['*://localhost/*', '*://127.0.0.1/*', '*://0.0.0.0/*', '*://[::1]/*'];

type Forwarding = Pick<LoopbackDeps, 'remoteForLocal' | 'open' | 'status'>;
let forwarding: Forwarding | null = null;

/** 端口转发那边(port-forward-controller.ts)起来时接上;没接上 = 一概放行(网页形态的会话页没有 SSH)。 */
export function setRemoteLoopbackForwarding(next: Forwarding | null): void {
  forwarding = next;
}

export function installRemoteLoopbackRequests(
  ses: Session,
  browserIdFor: (webContentsId: number) => string | null,
  warn: (message: string, fields: Record<string, unknown>) => void
): void {
  ses.webRequest.onBeforeRequest({ urls: LOOPBACK_URL_PATTERNS }, (details, callback) => {
    if (!forwarding || bindings.size === 0) {
      callback({});
      return;
    }
    const deps: LoopbackDeps = { ...forwarding, binding: remoteBrowserBinding, browserIdFor };
    void decideLoopbackRequest(details, deps).then(
      (decision) => {
        if ('redirect' in decision) callback({ redirectURL: decision.redirect });
        else if ('cancel' in decision) {
          warn('remote browser: port could not be forwarded, request blocked', { url: details.url });
          callback({ cancel: true });
        } else callback({});
      },
      () => callback({})
    );
  });
}
