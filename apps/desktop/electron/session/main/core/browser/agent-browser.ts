import type { WebContents } from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { agentSessionContext } from '@main/core/extensions/extension-agent-context';
import { openAgentBrowserPane } from '@main/core/sessions/session-orchestration';
import {
  browserAgentCursorChannel,
  browserAgentStateChannel,
  type BrowserAgentCursorEvent,
  type BrowserAgentState,
} from '@shared/events/browserEvents';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { acquireBrowserPage } from './browser-page-runtime';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';

/**
 * #7191 会话的 agent 操作会话页右侧的浏览器页签 —— 人在旁边实时看着,用的是这个页签的登录。
 *
 * 浏览器工具本身一个都不在这里:工具是 `@playwright/mcp` 原样的整套,它经 `connectOverCDP(transport)` 连上来。
 * 这里只有那条 transport 和围着它的产品行为:
 *
 * 1. **只把这一个页签交给 Playwright。** 直接把网页的 `webContents.debugger` 递过去时,Playwright 唯一认作
 *    page 的是咕咕自己的窗口,网页被它跳过(实测)。⇒ 浏览器级的 `Browser.*` / `Target.*` 由这里应答,只报这一页;
 *    attach 别的 target、建新页、关浏览器一律拒 —— 顺带挡住 agent 误操作咕咕界面或别的会话的页签。
 * 2. **不碰人的焦点(#7274)。** 网页是窗口里独立的一个 view(browser-page-views.ts),不是嵌在咕咕页面里的 `<webview>`:
 *    CDP 的点击、打字、按键都只在网页自己那棵焦点树里动,人在聊天框里拼着的中文不断、窗口焦点不动、前台 App 不换
 *    (exp8 / exp9 实测;`<webview>` 时 Chromium 一按下就把整棵树的焦点挪进网页,怎么补都会离开一瞬)。
 *    所以这里原样转发,❌ 打字前去聚焦网页、❌ 借 / 还焦点。
 * 3. **运行控制归 Agent 会话。** 浏览器没有独立暂停锁;人点网页、输入、滚动都不改变 Agent 的运行状态。
 *    会话取消当前调用时断开 transport,未发出的动作一起取消,页签与登录仍保留。
 * 4. **渲染需求由页面生命周期管理。** transport 取得当前页面的使用租约,原生视口就绪后才接收协议请求。
 *    只有 Agent 工作期间关闭后台节流;空闲、取消或断开后恢复。focus emulation 同样只在 driving 期间生效。
 * 5. **人看得见 agent 的鼠标。** Playwright 的每一下点击、悬停、滚动,以及打字前落进的那个输入框,先让页签上 agent 的
 *    鼠标移过去、到了再交给网页(owner 10-15:「最好是有一个鼠标能够停在哪儿的那种效果」)。鼠标飞的
 *    那半秒里调用被取消,这一下就不落下去。
 *
 * ⚠️ 网页销毁后不再碰它的 debugger:对已销毁的 webContents 发命令 / detach 会让整个 app 崩溃
 * (t3code#9067;上游 electron#53376 因不合模板被机器人关掉,没修)。
 */

/** `playwright-core` 的 `ConnectOverCDPTransport`(1.61+),照抄形状、不引它的类型:会话侧不依赖 Playwright。 */
export interface AgentBrowserTransport {
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

type CdpRequest = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

const PAGE_SESSION = 'gugu-agent-page';
const BROWSER_TARGET_ID = 'gugu-agent-browser';

/** 页签被 agent 用着时,这么久没有新动作就算 agent 不在操作了(后台页签改回不出帧)。 */
const DRIVING_IDLE_MS = 3_000;
/** 合成鼠标事件发出后这么久之内的按下,算 agent 自己的(它和人的点击经过同一个钩子)。 */
const SYNTHETIC_INPUT_GRACE_MS = 400;
/**
 * agent 的鼠标飞到位最多等这么久(cua 的轨迹 0.6–1.3 秒)。页签不在屏上时渲染层不播、当场回话;
 * 页签没人接这一声(渲染层没挂上)也只耽误这么久,❌ 卡住 agent。
 */
const CURSOR_ARRIVAL_CAP_MS = 1_500;
/** 网页没回「焦点在哪个输入框」就不等了 —— 网页卡住时 ❌ 连打字都卡住。 */
const FOCUS_LOOKUP_CAP_MS = 300;
/** 连着打字(逐键)时,这么久之内不再重新找输入框。 */
const TYPING_BURST_MS = 1_500;

/** 浏览器级别、只能由这里应答的命令以外,页面会话上也不许转给网页的那些 —— 它们够得着别的 target 或整个浏览器。 */
const PAGE_DENIED = /^(Target\.(attachToTarget|attachToBrowserTarget|getTargets|setDiscoverTargets|createTarget|closeTarget|activateTarget|exposeDevToolsProtocol|createBrowserContext|disposeBrowserContext|getBrowserContexts)|Browser\.|SystemInfo\.)/;
const TYPING = /^Input\.(insertText|dispatchKeyEvent|imeSetComposition)$/;

/** 网页里此刻有焦点的那个元素在哪(主框架视口的 CSS 像素);焦点在页面本身上就没有。 */
const FOCUSED_BOX = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body || e === document.documentElement) return null;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? [r.left, r.top, r.width, r.height] : null;
})()`;

let nextMoveId = 0;
const cursorArrivals = new Map<number, () => void>();

/** 页签上 agent 的鼠标到位了(渲染层回的那一声)。 */
export function agentCursorArrived(moveId: number): void {
  cursorArrivals.get(moveId)?.();
}

function emitCursor(event: BrowserAgentCursorEvent): void {
  events.emit(browserAgentCursorChannel, event);
}

/** 让页签上 agent 的鼠标飞到 (x, y),等它到位(最多 CURSOR_ARRIVAL_CAP_MS)。 */
function moveAgentCursor(
  browserId: string,
  x: number,
  y: number,
  target: [number, number, number, number] | null,
): Promise<void> {
  const moveId = ++nextMoveId;
  return new Promise((resolve) => {
    const arrived = () => {
      clearTimeout(timer);
      cursorArrivals.delete(moveId);
      resolve();
    };
    const timer = setTimeout(arrived, CURSOR_ARRIVAL_CAP_MS);
    timer.unref?.();
    cursorArrivals.set(moveId, arrived);
    emitCursor({ browserId, kind: 'move', moveId, x, y, target });
  });
}

type DrivenBrowser = {
  browserId: string;
  webContentsId: number;
  state: 'idle' | 'driving';
  inFlight: number;
  syntheticInputUntil: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 状态变了(transport 据此开关网页的 focus emulation,见文件头第 4 条)。 */
  onStateChange: (() => void) | null;
};

/** 每条会话的 agent 此刻用着的页签(transport 建立时定下,页签没了就清掉)。 */
const drivenBySession = new Map<string, DrivenBrowser>();
/**
 * 动作开始时这条会话还没连上页签的动作数(第一个动作往往要先开页签)。页签连上时并进它的 inFlight ——
 * 否则第一个动作期间页签既不显示「agent 正在操作」,切到后台也不出帧。页签断开时还没结束的动作同样记回这里。
 */
const inFlightWithoutTab = new Map<string, number>();
/** 下一次替这条会话开页签时直接开到的地址(agent 第一个动作就是打开某个网址时,❌ 先开一张空白页)。 */
const pendingInitialUrl = new Map<string, string>();
/** A lost webContents/transport is not a closed tab. Keep its identity for the next connection. */
const boundBrowserBySession = new Map<string, string>();

function setState(driven: DrivenBrowser, state: 'idle' | 'driving'): void {
  if (driven.state === state) return;
  const before = agentBrowserStateOf(driven.browserId);
  driven.state = state;
  const current = agentBrowserStateOf(driven.browserId);
  if (current !== before) events.emit(browserAgentStateChannel, { browserId: driven.browserId, state: current });
  driven.onStateChange?.();
}

/** 返回 true = 这一下是 agent 自己合成的点击(页签焦点不跟过去,❌ 把人正看着的页签换掉)。 */
browserWebContentsRegistry.setMouseDownObserver((browserId) => {
  for (const driven of drivenBySession.values()) {
    if (driven.browserId === browserId && Date.now() < driven.syntheticInputUntil) return true;
  }
  return false;
});

/**
 * 记录 Agent 当前正在执行浏览器调用,只用于鼠标提示和后台绘制。取消由调用本身的生命周期负责。
 */
export function agentBrowserToolStarting(sessionId: string): { ok: true } | { ok: false; message: string } {
  const driven = drivenBySession.get(sessionId);
  if (!driven) {
    inFlightWithoutTab.set(sessionId, (inFlightWithoutTab.get(sessionId) ?? 0) + 1);
    return { ok: true };
  }
  driven.inFlight += 1;
  if (driven.idleTimer) clearTimeout(driven.idleTimer);
  driven.idleTimer = null;
  setState(driven, 'driving');
  return { ok: true };
}

/** agent 的一个浏览器动作结束(成功或失败都调)。 */
export function agentBrowserToolFinished(sessionId: string): void {
  const driven = drivenBySession.get(sessionId);
  if (!driven) {
    const left = (inFlightWithoutTab.get(sessionId) ?? 0) - 1;
    if (left > 0) inFlightWithoutTab.set(sessionId, left);
    else inFlightWithoutTab.delete(sessionId);
    return;
  }
  driven.inFlight = Math.max(0, driven.inFlight - 1);
  if (driven.inFlight > 0) return;
  if (driven.idleTimer) clearTimeout(driven.idleTimer);
  driven.idleTimer = setTimeout(() => {
    driven.idleTimer = null;
    if (driven.inFlight === 0 && driven.state === 'driving') setState(driven, 'idle');
  }, DRIVING_IDLE_MS);
  driven.idleTimer.unref?.();
}

/** Current activity for a logical tab, queried when a renderer mounts after its event. */
export function agentBrowserStateOf(browserId: string): BrowserAgentState {
  let state: BrowserAgentState = 'idle';
  for (const driven of drivenBySession.values()) {
    if (driven.browserId !== browserId) continue;
    if (driven.state === 'driving') state = 'driving';
  }
  return state;
}

/** Logical tab closure releases its remembered identity; losing a transport does not. */
export function forgetAgentBrowser(browserId: string): void {
  for (const [sessionId, bound] of boundBrowserBySession) {
    if (bound === browserId) boundBrowserBySession.delete(sessionId);
  }
}

/** 下一次替这条会话开页签时开到这个地址(见 `pendingInitialUrl`)。 */
export function setAgentBrowserInitialUrl(sessionId: string, url: string | null): void {
  if (url) pendingInitialUrl.set(sessionId, url);
  else pendingInitialUrl.delete(sessionId);
}

async function acquireSessionBrowser(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ browserId: string; webContents: WebContents }> {
  const context = await agentSessionContext(sessionId);
  if (!context) throw new Error('this session is not on this computer, so it has no browser tab to drive');
  const url = pendingInitialUrl.get(sessionId);
  pendingInitialUrl.delete(sessionId);
  const browserId = await openAgentBrowserPane(
    { projectId: context.projectId, sessionId }, url, signal,
    boundBrowserBySession.get(sessionId) ?? browserWebContentsRegistry.preferredBrowserOfSession(sessionId),
  );
  signal?.throwIfAborted();
  const restored = browserWebContentsRegistry.browsersOfSession(sessionId).find((page) => page.browserId === browserId);
  if (!restored) throw new Error('the restored browser tab has no live page to drive');
  boundBrowserBySession.set(sessionId, browserId);
  return restored;
}

/**
 * 给这条会话的 agent 一条连到它浏览器页签的 CDP transport(交给 `chromium.connectOverCDP`)。
 * 会话还没有页签就先开一个。一条会话同时只有一条:Playwright 断开 / 页签关掉,下次调用再建。
 */
export async function openAgentBrowserTransport(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AgentBrowserTransport> {
  const { browserId, webContents } = await acquireSessionBrowser(sessionId, signal);
  return createPaneTransport(sessionId, browserId, webContents);
}

/** 拆出来便于测:给定一个页签的 webContents,造那条只报这一页的 transport。 */
export function createPaneTransport(
  sessionId: string,
  browserId: string,
  webContents: WebContents,
): AgentBrowserTransport {
  boundBrowserBySession.set(sessionId, browserId);
  const dbg = webContents.debugger;
  const children = new Set<string>();
  let targetInfo: Record<string, unknown> | null = null;
  let closed = false;
  const transport: AgentBrowserTransport = { send, close };
  const page = acquireBrowserPage(webContents);
  // Observe rejection immediately, including a connection cancelled before its first request.
  void page?.ready.catch(() => {});

  const previous = drivenBySession.get(sessionId);
  if (previous?.idleTimer) clearTimeout(previous.idleTimer);
  const carried = inFlightWithoutTab.get(sessionId) ?? 0;
  inFlightWithoutTab.delete(sessionId);
  const driven: DrivenBrowser = {
    browserId,
    webContentsId: webContents.id,
    state: previous?.browserId === browserId ? previous.state : 'idle',
    inFlight: carried + (previous?.inFlight ?? 0),
    syntheticInputUntil: 0,
    idleTimer: null,
    onStateChange: null,
  };
  drivenBySession.set(sessionId, driven);
  if (driven.inFlight > 0) setState(driven, 'driving');

  // 异步投递:Playwright 不接受在 send() 还没返回时就收到回应。
  const emit = (message: object) =>
    setImmediate(() => {
      if (!closed) transport.onmessage?.(message);
    });

  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>, childSessionId?: string) => {
    if (method === 'Target.attachedToTarget') children.add(String((params as { sessionId?: unknown }).sessionId));
    if (method === 'Target.detachedFromTarget') children.delete(String((params as { sessionId?: unknown }).sessionId));
    emit({ method, params, sessionId: childSessionId || PAGE_SESSION });
  };
  const onDetach = (_event: unknown, reason: string) => finish(`debugger detached: ${reason}`);
  const onDestroyed = () => finish('the browser tab was closed');

  function finish(reason: string) {
    if (closed) return;
    closed = true;
    page?.dispose();
    dbg.removeListener('message', onMessage);
    dbg.removeListener('detach', onDetach);
    if (drivenBySession.get(sessionId) === driven) {
      if (driven.idleTimer) clearTimeout(driven.idleTimer);
      const before = agentBrowserStateOf(browserId);
      drivenBySession.delete(sessionId);
      if (driven.inFlight > 0) inFlightWithoutTab.set(sessionId, (inFlightWithoutTab.get(sessionId) ?? 0) + driven.inFlight);
      const current = agentBrowserStateOf(browserId);
      if (current !== before) events.emit(browserAgentStateChannel, { browserId, state: current });
    }
    transport.onclose?.(reason);
  }

  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);
  webContents.once('destroyed', onDestroyed);

  // 文件头第 4 条:Playwright 要的 focus emulation 只在 agent 操作期间真开着。
  let focusEmulationWanted = false;
  let focusEmulationOn = false;
  const applyFocusEmulation = () => {
    const on = focusEmulationWanted && driven.state === 'driving';
    if (on === focusEmulationOn || closed || webContents.isDestroyed() || !dbg.isAttached()) return;
    focusEmulationOn = on;
    log.debug('Agent browser: focus emulation', { browserId, on });
    dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: on }).catch((error: unknown) => {
      log.warn('Agent browser: switching focus emulation failed', { browserId, on, error: String(error) });
    });
  };
  driven.onStateChange = () => {
    page?.setActive(driven.state === 'driving');
    applyFocusEmulation();
  };
  page?.setActive(driven.state === 'driving');

  // 交给网页的上一条命令发出去了没有(send 里按到达顺序排队用)。
  let dispatchGate: Promise<void> = Promise.resolve();
  // agent 的鼠标此刻停在哪(页签 CSS 像素);逐键打字时这段时间内不再重新找输入框。
  let cursorAt: { x: number; y: number } | null = null;
  let typingUntil = 0;

  async function focusedBox(): Promise<number[] | null> {
    const lookup = dbg.sendCommand('Runtime.evaluate', { expression: FOCUSED_BOX, returnByValue: true }) as Promise<{
      result?: { value?: unknown };
    }>;
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), FOCUS_LOOKUP_CAP_MS).unref?.();
    });
    try {
      const value = (await Promise.race([lookup, timeout]))?.result?.value;
      return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number') ? value : null;
    } catch {
      return null;
    }
  }

  /** 这一下交给网页之前,页签上 agent 的鼠标先过去(见文件头第 5 条)。 */
  async function showAgentPointer(method: string, params: Record<string, unknown>) {
    const zoom = webContents.getZoomFactor();
    if (method === 'Input.dispatchMouseEvent') {
      typingUntil = 0;
      const type = String(params.type);
      if (type === 'mousePressed') return emitCursor({ browserId, kind: 'click' });
      if (type !== 'mouseMoved' && type !== 'mouseWheel') return;
      const to = { x: Number(params.x) * zoom, y: Number(params.y) * zoom };
      if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;
      if (cursorAt && Math.hypot(to.x - cursorAt.x, to.y - cursorAt.y) < 1) return;
      cursorAt = to;
      const arrival = moveAgentCursor(browserId, to.x, to.y, null);
      // 拖拽途中按着键的每一步不等:鼠标跟着走就行,一步一停拖拽就断了。
      if (Number(params.buttons ?? 0) === 0) await arrival;
      return;
    }
    const now = Date.now();
    if (now < typingUntil) {
      typingUntil = now + TYPING_BURST_MS;
      return;
    }
    const box = (await focusedBox())?.map((v) => v * zoom) as [number, number, number, number] | undefined;
    typingUntil = Date.now() + TYPING_BURST_MS;
    if (!box) return;
    const [left, top, width, height] = box;
    if (cursorAt && cursorAt.x >= left && cursorAt.x <= left + width && cursorAt.y >= top && cursorAt.y <= top + height) return;
    cursorAt = { x: left + Math.min(16, width / 2), y: top + height / 2 };
    await moveAgentCursor(browserId, cursorAt.x, cursorAt.y, box);
  }

  async function send(raw: object) {
    const { id, method, params = {}, sessionId: cdpSession } = raw as CdpRequest;
    const reply = (result: unknown) => emit({ id, sessionId: cdpSession, result });
    const fail = (message: string) => emit({ id, sessionId: cdpSession, error: { message } });
    try {
      if (closed || webContents.isDestroyed()) return fail('the browser tab was closed');
      await page?.ready;
      if (closed || webContents.isDestroyed()) return fail('the browser tab was closed');
      if (!cdpSession) {
        // 浏览器级:全由这里应答,❌ 转给网页。
        if (method === 'Browser.getVersion') {
          // 真实的 Chrome 版本:Playwright 按主版本号分路(如 worker 就绪的等法),报个非数字它两条路都不走。
          return reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: webContents.getUserAgent(), jsVersion: process.versions.v8 });
        }
        if (method === 'Target.setAutoAttach') {
          if (!dbg.isAttached()) dbg.attach('1.3');
          const info = (await dbg.sendCommand('Target.getTargetInfo')) as { targetInfo: Record<string, unknown> };
          targetInfo = info.targetInfo;
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
        log.info('Agent browser: refused a browser-level command', { method });
        return fail(`gugu browser tab: browser-level ${method} is not available (this connection drives one tab)`);
      }
      if (cdpSession !== PAGE_SESSION && !children.has(cdpSession)) return fail('unknown session');
      if (PAGE_DENIED.test(method)) {
        log.info('Agent browser: refused a command', { method });
        return fail(`gugu browser tab: ${method} is not available (this connection drives one tab)`);
      }
      if (method === 'Target.getTargetInfo' && cdpSession === PAGE_SESSION && targetInfo) {
        return reply({ targetInfo: { ...targetInfo, type: 'page' } });
      }
      if (method === 'Emulation.setFocusEmulationEnabled' && cdpSession === PAGE_SESSION) {
        focusEmulationWanted = (params as { enabled?: unknown } | undefined)?.enabled === true;
        applyFocusEmulation();
        return reply({});
      }
      const synthetic = method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchTouchEvent';
      // 按 Playwright 发来的顺序交给网页:一次点击它是「移过去 / 按下 / 抬起」三条连发、不等回话(playwright-core
      // Mouse.click 的 Promise.all)。前一条还在等鼠标飞到位,后面的就排在它后面 —— ❌ 抢先落到网页上(10-15 实测:
      // 不排队时标题先变、鼠标后到)。
      const prior = dispatchGate;
      let release = () => {};
      dispatchGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let result: Promise<unknown>;
      try {
        await prior;
        if (closed || webContents.isDestroyed()) return fail('the browser tab was closed');
        if (method === 'Input.dispatchMouseEvent' || TYPING.test(method)) {
          await showAgentPointer(method, params);
          // Cancelling the call can close this transport while the cursor is still moving.
          if (closed || webContents.isDestroyed()) return fail('the browser connection was closed');
        }
        if (method === 'Page.getFrameTree' && cdpSession === PAGE_SESSION) {
          // Playwright installs Runtime context listeners after this response. Keep Runtime.enable behind it,
          // including the metadata lookup, so the existing document's context events cannot overtake the tree.
          let response = await dbg.sendCommand(method, params);
          if (closed || webContents.isDestroyed()) return fail('the browser tab was closed');
          type FrameTreeResult = { frameTree: { frame: { url: string } } };
          const tree = response as FrameTreeResult;
          if (tree.frameTree.frame.url === '' || tree.frameTree.frame.url === ':') {
            // Chromium's initial document exists even before any navigation commits (including downloads).
            // Its frame metadata has no URL, while document.URL reports the actual about:blank document.
            // Expose that document so attaching does not depend on a future navigation or change the page.
            const document = await dbg.sendCommand('Runtime.evaluate', {
              expression: 'document.URL', returnByValue: true, silent: true,
            }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
            if (closed || webContents.isDestroyed()) return fail('the browser tab was closed');
            const documentUrl = document.result?.value;
            if (document.exceptionDetails || typeof documentUrl !== 'string' || !documentUrl || documentUrl === ':') {
              throw new Error('could not read the browser tab\'s initial document URL');
            }
            if (documentUrl === 'about:blank') {
              response = { ...tree, frameTree: { ...tree.frameTree, frame: { ...tree.frameTree.frame, url: documentUrl } } };
            } else {
              // A real navigation committed during the lookup: use its whole frame tree, including loader/origin.
              response = await dbg.sendCommand('Page.getFrameTree') as FrameTreeResult;
              const url = (response as FrameTreeResult).frameTree.frame.url;
              if (!url || url === ':') throw new Error('the browser tab\'s initial document changed before it could be read');
            }
          }
          reply(response);
          return;
        }
        if (synthetic) driven.syntheticInputUntil = Number.POSITIVE_INFINITY;
        result = method === 'Page.captureScreenshot' && cdpSession === PAGE_SESSION && page
          ? page.capture(params)
          : dbg.sendCommand(method, params, cdpSession === PAGE_SESSION ? undefined : cdpSession);
      } finally {
        release();
      }
      try {
        reply(await result);
      } finally {
        if (synthetic) driven.syntheticInputUntil = Date.now() + SYNTHETIC_INPUT_GRACE_MS;
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  function close() {
    if (closed) return;
    webContents.removeListener('destroyed', onDestroyed);
    if (!webContents.isDestroyed() && dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (error) {
        log.warn('Agent browser: detaching the debugger failed', { browserId, error: String(error) });
      }
    }
    finish('closed by the agent');
  }

  return transport;
}

/** Local session browser actions exposed to the host. */
export type AgentBrowserBridgeShape = {
  states?: () => NonNullable<ExtensionAgentStatus['sessions']>;
  openTransport: (sessionId: string, signal?: AbortSignal) => Promise<AgentBrowserTransport>;
  toolStarting: (sessionId: string) => { ok: true } | { ok: false; message: string };
  toolFinished: (sessionId: string) => void;
  setInitialUrl: (sessionId: string, url: string | null) => void;
  workspaceRoot: (sessionId: string) => Promise<string | null>;

};

/**
 * 宿主(电子主进程那一侧的 MCP 层)经桥拿到的那几个动作 —— 一处出口,类型由宿主 `typeof` 引用。
 */
export function agentBrowserBridge(): AgentBrowserBridgeShape {
  return {
    states: () => [...drivenBySession].flatMap(([sessionId, driven]) => {
      const page = browserWebContentsRegistry.browsersOfSession(sessionId).find((candidate) => candidate.browserId === driven.browserId);
      return page ? [{ sessionId, browserId: driven.browserId, state: agentBrowserStateOf(driven.browserId),
        title: page.webContents.getTitle(), url: page.webContents.getURL() }] : [];
    }),
    openTransport: openAgentBrowserTransport,
    toolStarting: agentBrowserToolStarting,
    toolFinished: agentBrowserToolFinished,
    setInitialUrl: setAgentBrowserInitialUrl,
    workspaceRoot: async (sessionId: string) => (await agentSessionContext(sessionId))?.workspaceRoot ?? null,
  };
}
