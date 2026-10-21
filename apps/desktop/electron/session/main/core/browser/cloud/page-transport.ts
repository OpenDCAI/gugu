import type { AgentBrowserTransport } from '../agent-browser';
import type { CdpEvent, CdpHub } from './cdp-hub';

/**
 * #7199 云电脑上一条会话的 agent 驱动它自己那一个页签:交给 Playwright `connectOverCDP(transport)` 的那条 transport。
 *
 * 与桌面那份(agent-browser.ts `createPaneTransport`)同一个形状:浏览器级的 `Browser.*` / `Target.*` 由这里应答,
 * 只报这一页;attach 别的页签、建新页、关浏览器一律拒 —— 一条会话看不见、碰不到别的会话(和人)的页签。
 * 不同的只是底下:桌面是 `<webview>` 的 debugger,这里是那一个 Chrome 上的 flatten 会话(cdp-hub.ts)。
 */
export const PAGE_SESSION = 'gugu-agent-page';
const BROWSER_TARGET_ID = 'gugu-agent-browser';

const PAGE_DENIED =
  /^(Target\.(attachToTarget|attachToBrowserTarget|getTargets|setDiscoverTargets|createTarget|closeTarget|activateTarget|exposeDevToolsProtocol|createBrowserContext|disposeBrowserContext|getBrowserContexts)|Browser\.|SystemInfo\.)/;

type CdpRequest = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

export type PageTransportHooks = {
  /** 每个交给网页的命令之前问一句(人接管 / 停了 = 拒,原话交回 agent)。null = 放行。 */
  refuse?: (method: string) => string | null;
  onClosed?: (reason: string) => void;
};

/**
 * 在 `hub` 上 attach 那个页签,造只报这一页的 transport。`targetId` 必须是一个 page。
 */
export async function createCloudPageTransport(hub: CdpHub, targetId: string, hooks: PageTransportHooks = {}): Promise<AgentBrowserTransport> {
  const { sessionId: pageSession } = await hub.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const { targetInfo } = await hub.send<{ targetInfo: Record<string, unknown> }>('Target.getTargetInfo', { targetId });
  const version = await hub.send<Record<string, unknown>>('Browser.getVersion');
  const children = new Set<string>();
  let closed = false;
  const transport: AgentBrowserTransport = { send, close };

  // 异步投递:Playwright 不接受在 send() 还没返回时就收到回应。
  const emit = (message: object) =>
    setImmediate(() => {
      if (!closed) transport.onmessage?.(message);
    });

  const ours = (sessionId: string | undefined) => sessionId === pageSession || (!!sessionId && children.has(sessionId));

  const offEvent = hub.onEvent((event: CdpEvent) => {
    if (event.method === 'Target.detachedFromTarget' && !event.sessionId && event.params.sessionId === pageSession) {
      finish('the browser tab was closed');
      return;
    }
    if (event.method === 'Target.targetDestroyed' && !event.sessionId && event.params.targetId === targetId) {
      finish('the browser tab was closed');
      return;
    }
    if (!ours(event.sessionId)) return;
    if (event.method === 'Target.attachedToTarget') children.add(String(event.params.sessionId));
    if (event.method === 'Target.detachedFromTarget') children.delete(String(event.params.sessionId));
    emit({ method: event.method, params: event.params, sessionId: event.sessionId === pageSession ? PAGE_SESSION : event.sessionId });
  });
  const offClose = hub.onClose((reason) => finish(reason));

  function finish(reason: string) {
    if (closed) return;
    closed = true;
    offEvent();
    offClose();
    hooks.onClosed?.(reason);
    transport.onclose?.(reason);
  }

  async function send(raw: object) {
    const { id, method, params = {}, sessionId: cdpSession } = raw as CdpRequest;
    const reply = (result: unknown) => emit({ id, sessionId: cdpSession, result });
    const fail = (message: string) => emit({ id, sessionId: cdpSession, error: { message } });
    try {
      if (closed) return fail('the browser tab was closed');
      if (!cdpSession) {
        // 浏览器级:全由这里应答,❌ 转给 Chrome(那样就够到了别的页签)。
        if (method === 'Browser.getVersion') return reply(version);
        if (method === 'Target.setAutoAttach') {
          reply({});
          return emit({
            method: 'Target.attachedToTarget',
            params: { sessionId: PAGE_SESSION, targetInfo: { ...targetInfo, type: 'page', attached: true }, waitingForDebugger: false },
          });
        }
        if (method === 'Target.getTargetInfo') {
          return reply({ targetInfo: { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } });
        }
        if (method === 'Target.getBrowserContexts') return reply({ browserContextIds: [] });
        if (/^Browser\.(setDownloadBehavior|grantPermissions|resetPermissions)$/.test(method)) return reply({});
        return fail(`gugu browser tab: browser-level ${method} is not available (this connection drives one tab)`);
      }
      if (cdpSession !== PAGE_SESSION && !children.has(cdpSession)) return fail('unknown session');
      if (PAGE_DENIED.test(method)) return fail(`gugu browser tab: ${method} is not available (this connection drives one tab)`);
      if (method === 'Target.getTargetInfo' && cdpSession === PAGE_SESSION) return reply({ targetInfo: { ...targetInfo, type: 'page' } });
      const refusal = hooks.refuse?.(method);
      if (refusal) return fail(refusal);
      reply(await hub.send(method, params, cdpSession === PAGE_SESSION ? pageSession : cdpSession));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  function close() {
    if (closed) return;
    // 页签留给人看(和桌面一样):只断开 agent 这一条,❌ 关页签。
    void hub.send('Target.detachFromTarget', { sessionId: pageSession }).catch(() => undefined);
    finish('closed by the agent');
  }

  return transport;
}
