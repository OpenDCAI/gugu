// #6264 别的机器上的会话调 `session_open_in_tab`:那台机器没有窗口,tab 开在这里 —— 正看着这条会话的这台电脑的
// 右侧工作区(behavior gugu-server-multi-device「会话右侧工作区跟着会话走」;路由在那台机器的 remote-pane.ts)。
//
// 这里只做「我正看着」这一件事的生命周期,纯逻辑(连接与打开动作注入,单测钉每条分支):
//  · 看着 = 经会话页宿主那条连接订上;先挂推送再订阅(订阅应答之前推来的那一条不丢);订阅应答里攒着的那几条照开。
//  · 订阅的寿命就是连接的寿命:断了那台机器当场撤掉,连回来这里重订 —— 断线期间攒下的随订阅应答送到。
//  · 每一条开完都回话(成功 / 闭集原因),机器据此答 agent —— ❌ 不回,agent 就干等到超时。
//  · 不看了(关掉会话 / 换一条)= 退订;之后的打开请求由那台机器攒着,下次再看时照开。
import {
  isSessionpagePaneOpenEvent,
  type SessionPaneTabsResult,
  type SessionpagePaneFailure,
  type SessionpagePaneOpenRequest,
} from '@gugu/session-core/session-record/contract';
import { SESSION_HOST_PANE, type SessionHostPaneSubscribe } from '@shared/lib/ipc/session-host-device-frames';

export type PaneOpenResult = ({ ok: true } & SessionPaneTabsResult) | { ok: false; failure: SessionpagePaneFailure; error?: string };

/** 到那台机器的那条连接(生产装配见 machine-session-wiring.ts)。 */
export type PaneLink = {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  /** 那台机器推来的打开请求(只推给订它的这条连接)。 */
  onOpenEvent(cb: (event: unknown) => void): () => void;
  /** 连接断了又连上(那台机器已撤掉旧订阅)。 */
  onReconnected(cb: () => void): () => void;
};

export type RemotePaneViewerDeps = {
  link: PaneLink;
  deviceId: string;
  sessionId: string;
  /** 这条会话在这台电脑上有没有浏览器格(只有远程 SSH 装上的机器有)。 */
  browser: boolean;
  /** 真正在工作区里开这一格(群里的文件要先读出它在哪个群,开没开成晚一拍才知道 —— F112)。 */
  open: (request: SessionpagePaneOpenRequest) => PaneOpenResult | Promise<PaneOpenResult>;
  newId?: () => string;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/** 开始「看着」;返回停止。 */
export function startRemotePaneViewer(deps: RemotePaneViewerDeps): () => void {
  const { link, deviceId, sessionId } = deps;
  const log = deps.log ?? (() => undefined);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let subscriptionId = newId();
  let stopped = false;
  const handled = new Set<string>();

  const handle = (request: SessionpagePaneOpenRequest, forSubscription: string) => {
    if (stopped || request.sessionId !== sessionId) return;
    // 同一条请求只开一次(重订后机器可能再给一遍攒着的)。
    if (handled.has(request.requestId)) return;
    handled.add(request.requestId);
    const threw = (error: unknown): PaneOpenResult => {
      log('remote pane open threw', { deviceId, sessionId, requestId: request.requestId, error: String(error) });
      return { ok: false, failure: 'open_failed' };
    };
    const answer = (result: PaneOpenResult) =>
      void link
        .invoke(SESSION_HOST_PANE.opened, {
          requestId: request.requestId,
          subscriptionId: forSubscription,
          ok: result.ok,
          ...(result.ok ? { ...result } : { failure: result.failure, ...(result.error ? { error: result.error } : {}) }),
        })
        .catch((error: unknown) => log('remote pane ack failed', { deviceId, requestId: request.requestId, error: String(error) }));
    let result: PaneOpenResult | Promise<PaneOpenResult>;
    try {
      result = deps.open(request);
    } catch (error) {
      result = threw(error);
    }
    if (result instanceof Promise) void result.catch(threw).then(answer);
    else answer(result);
  };

  const offEvents = link.onOpenEvent((event) => {
    if (isSessionpagePaneOpenEvent(event) && event.subscriptionId === subscriptionId) handle(event.request, event.subscriptionId);
  });

  const subscribe = () => {
    const id = subscriptionId;
    void link
      // pages:这台电脑的浏览器格渲染得了那台机器上的 `file:` 网页;external:接得住那台机器上的程序「打开网页」。
      .invoke(SESSION_HOST_PANE.subscribe, { subscriptionId: id, sessionId, browser: deps.browser, pages: deps.browser, external: true, tabs: true } satisfies SessionHostPaneSubscribe)
      .then((result) => {
        if (stopped) return;
        const pending = (result as { pending?: SessionpagePaneOpenRequest[] } | null)?.pending ?? [];
        for (const request of pending) handle(request, id);
      })
      .catch((error: unknown) => {
        // 暂时够不着:连回来时重订。
        if (!stopped) log('remote pane subscribe failed', { deviceId, sessionId, error: String(error) });
      });
  };

  const offReconnect = link.onReconnected(() => {
    if (stopped) return;
    subscriptionId = newId();
    subscribe();
  });
  subscribe();

  return () => {
    if (stopped) return;
    stopped = true;
    offEvents();
    offReconnect();
    // 订阅应答还没回来也退一次:机器那边若已登记,不退就要等连接断了才拆。
    void link.invoke(SESSION_HOST_PANE.unsubscribe, subscriptionId).catch(() => undefined);
  };
}

/**
 * 让在跑的「看着」正好是想要的这些(键 → 开始):新出现的开始,不再要的停,还要的原样留着 ——
 * ❌ 屏上每变一下就全部退订重订(那台机器在两拍之间会以为没人看着,攒着的请求也白绕一圈)。
 */
export function syncRemotePaneViewers(running: Map<string, () => void>, wanted: ReadonlyMap<string, () => () => void>): void {
  for (const [key, stop] of running) {
    if (wanted.has(key)) continue;
    stop();
    running.delete(key);
  }
  for (const [key, start] of wanted) {
    if (!running.has(key)) running.set(key, start());
  }
}
