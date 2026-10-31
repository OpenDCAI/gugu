/**
 * #6264 咕咕 server 上的会话调 `session_open_in_tab`:这台机器没有窗口,tab 开在**正看着这条会话的那台桌面**
 * 的右侧工作区里(behavior gugu-server-multi-device「会话右侧工作区跟着会话走」;流程与形状见 pane-contract.ts)。
 *
 * 这里是路由本身,纯逻辑(计时器与 id 注入,单测钉每条分支):
 *  · 有桌面看着 ⇒ 推给每个开得了这一格的订阅,等第一声「开好了」;都说没开成 ⇒ 按原因失败;10 秒没人回 ⇒ 如实失败。
 *  · 没人看着 ⇒ 攒着,下一台打开这条会话的桌面订上时照开,agent 立刻拿到「已排队」。这与本机的行为对齐:
 *    本机任务不在眼前时 tab 也照样落进它的面板,人回来就看见(open-file-in-file-editor 的 when(viewModel))。
 *    ❌ 让 agent 干等 10 秒超时 —— 那正是 owner 在 d22 上撞到的「等待任务面板打开超时」。
 *  · 浏览器格只有远程 SSH 装上的机器有:看着的桌面都没有这一格 ⇒ 当场失败并说清楚,❌ 攒一个永远开不出来的请求。
 *
 * 攒着的有界(每条会话最多 `MAX_QUEUED_PER_SESSION` 条、全机最多 `MAX_QUEUED_SESSIONS` 条会话、
 * 一天没人来就丢),同一目标重复开只留最后一次;只在内存里 —— server 重启就丢,那时 agent 那一轮早已结束。
 */
import { randomUUID } from 'node:crypto';
import type {
  SessionPaneTabsResult,
  SessionpagePaneFailure,
  SessionpagePaneIntent,
  SessionpagePaneOpenEvent,
  SessionpagePaneOpenRequest,
  SessionpagePaneTarget,
} from '@gugu/session-core/session-record/contract';

export const PANE_ACK_TIMEOUT_MS = 10_000;
export const MAX_QUEUED_PER_SESSION = 10;
export const MAX_QUEUED_SESSIONS = 100;
export const QUEUED_TTL_MS = 24 * 60 * 60_000;

/**
 * 给 agent 的失败原因(闭集)。文案在 `describeRemotePaneFailure`,一处写、单测钉。
 *  · `no_browser`      看着这条会话的桌面上没有浏览器格(那台机器只经远程隧道连着);
 *  · `open_failed`     桌面开的时候出错了;
 *  · `viewer_outdated` 看着的桌面有浏览器格,但版本太旧,渲染不了这台机器上的 `file:` 网页;
 *  · `viewer_timeout`  推出去了,10 秒没有一台桌面回话(只剩在单测里:真跑时攒着,见 open);
 *  · `no_viewer`       要在人那一侧开网页,却认不出是哪条会话、此刻也没有一台桌面看着这台机器。
 */
export type RemotePaneErrorCode = 'no_browser' | 'viewer_outdated' | 'open_failed' | 'viewer_timeout' | 'no_viewer';

export class RemotePaneError extends Error {
  constructor(readonly code: RemotePaneErrorCode) {
    super(describeRemotePaneFailure(code));
    this.name = 'RemotePaneError';
  }
}

/** agent 读的那一句:发生了什么 + 接下来怎么做。英文(咕咕交给 agent 的文字一律英文,见 behavior gugu-plugin)。 */
export function describeRemotePaneFailure(code: RemotePaneErrorCode): string {
  switch (code) {
    case 'no_browser':
      return 'cannot open a page here: this session runs on a machine connected through a remote tunnel, and its workspace has no browser tab (only machines added over remote SSH have one). Put the URL in your reply instead, or save the page as a file in the working directory and open it with path.';
    case 'viewer_outdated':
      return 'cannot open this page here: the Gugu app showing this session is too old to render pages from this machine. Open the file with path instead (it shows in the file tab), or tell the person the path in your reply.';
    case 'open_failed':
      return 'the Gugu window showing this session could not open it. Tell the person the path or URL in your reply.';
    case 'viewer_timeout':
      return 'the Gugu window showing this session did not confirm within 10s, so the tab may not have opened. Tell the person the path or URL in your reply.';
    case 'no_viewer':
      return 'no Gugu window is showing this machine right now, so the page could not be opened on the person\'s computer. Tell the person the URL.';
  }
}

/** 没人看着、已攒下时,工具结果里给 agent 的那一句(tab 本身就是信号,与本机同一条纪律:❌ 叫它再发消息催人)。 */
export const REMOTE_PANE_QUEUED_NOTE =
  'No one has this session open in Gugu right now. The tab will open in this session\'s workspace the next time someone opens the session.';

/**
 * #6264 桌面还挂着订阅、却 10 秒没回话(合盖睡着 / 被杀而没来得及退订,订阅要 90 秒 + 清扫才拆):
 * 与「没人看着」同一个处理 —— 攒着,那台桌面醒来(下一次保活)或下一台打开会话时补开。❌ 报超时让 tab 永远不出现。
 */
export const REMOTE_PANE_UNCONFIRMED_NOTE =
  'The Gugu window showing this session did not answer in time (it may be asleep). The tab will open in this session\'s workspace as soon as that window is back, or the next time someone opens the session.';

export function remotePaneQueuedNote(outcome: { queued: true; unconfirmed?: true }): string {
  return outcome.unconfirmed ? REMOTE_PANE_UNCONFIRMED_NOTE : REMOTE_PANE_QUEUED_NOTE;
}

/** 咕咕 server 上的文件格只读会话工作目录里的东西(远端工作区的边界,见 remote-workspace.ts)。 */
export function describeOutsideWorkspace(root: string): string {
  return `cannot open this file here: on a Gugu server the workspace pane only shows files inside this session's working directory (${root}). Copy the file into it and open that copy, or send it with message_send_file.`;
}

/**
 * `file:` 网页在桌面的浏览器格里渲染:字节经会话工作区的读文件动词从这台机器取,所以只认**会话工作目录里**的文件
 * (与文件格同一道边界)。目录外的、不是文件的,当场说清楚,❌ 推过去再开出一个打不开的页。
 */
export function describePageOutsideWorkspace(root: string): string {
  return `cannot open this page here: on a Gugu server the browser tab only renders files inside this session's working directory (${root}). Save the page there and open file://<that path>, or open it with path.`;
}

export const REMOTE_PANE_PAGE_NOT_FILE =
  'cannot open this page here: the file:// URL does not point to a file on this machine. Check the path, or open a file with path.';

/** 这一格是「这台机器上的网页」(`file:`)—— 只有渲染得了它的桌面开得了。 */
export function isRemotePageTarget(target: SessionpagePaneTarget): boolean {
  return target.kind === 'browser' && target.url.startsWith('file:');
}

/** App 的页面画在有窗口的咕咕桌面上;咕咕 server 没有窗口(behavior gugu-server-multi-device「扩展」那一格),装在上面的 App 只有工具和技能。 */
export const REMOTE_PANE_NO_EXTENSIONS =
  'cannot open an App tab here: this session runs on a Gugu server, which has no window, so no App page opens on it (Apps installed there give agents their tools and skills only). Open a file with path or a page with url instead.';

export type RemotePaneOutcome = ({ opened: true } & SessionPaneTabsResult) | { queued: true; unconfirmed?: true };

type Viewer = {
  subscriptionId: string;
  sessionId: string;
  browser: boolean;
  /** 渲染得了这台机器上的 `file:` 网页(老桌面不带 = 不能)。 */
  pages: boolean;
  /** 接得住「在人那一侧打开网页」(`external`,见 remote-open-external.ts;老桌面不带 = 不能)。 */
  external: boolean;
  tabs: boolean;
  /** 最后一次订上 / 保活的时刻:这台机器上的程序要开网页、又认不出是哪条会话时,交给最近还活着的那台桌面。 */
  seenAt: number;
  publish: (event: SessionpagePaneOpenEvent) => void;
};

/** 这台桌面开不开得了这一格。 */
function canOpen(viewer: Pick<Viewer, 'browser' | 'pages' | 'external' | 'tabs'>, target: SessionpagePaneTarget): boolean {
  if (target.kind === 'tabs' || target.kind === 'close-tab') return viewer.tabs;
  if (target.kind === 'external') return viewer.external;
  if (target.kind !== 'browser') return true;
  return viewer.browser && (!isRemotePageTarget(target) || viewer.pages);
}

/** `left` 只在内部用:推给的桌面在回话前全走了(关掉会话 / 被清扫),与「没人看着」同一个处理。 */
type Settled = ({ ok: true } & SessionPaneTabsResult) | { ok: false; code: RemotePaneErrorCode | 'left'; error?: string };

type Waiter = {
  outstanding: Set<string>;
  failures: SessionpagePaneFailure[];
  settle: (outcome: Settled) => void;
};

type Queued = { request: SessionpagePaneOpenRequest; at: number };

export type RemotePaneRouteOptions = {
  ackTimeoutMs?: number;
  now?: () => number;
  newId?: () => string;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

export type RemotePaneRoute = ReturnType<typeof createRemotePaneRoute>;

function sameTarget(a: SessionpagePaneTarget, b: SessionpagePaneTarget): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path;
  if (a.kind === 'browser' && b.kind === 'browser') return a.url === b.url;
  if (a.kind === 'external' && b.kind === 'external') return a.url === b.url;
  return false;
}

export function createRemotePaneRoute(options: RemotePaneRouteOptions = {}) {
  const ackTimeoutMs = options.ackTimeoutMs ?? PANE_ACK_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const viewers = new Map<string, Viewer>();
  const waiters = new Map<string, Waiter>();
  /** 会话 → 没人看着时攒下的请求(Map 的插入序 = 最早攒的会话在前,超额时先丢它)。 */
  const queued = new Map<string, Queued[]>();
  /**
   * 这台机器被哪种桌面看过:有过一台带浏览器格的 ⇒ 'some'(没人看着时浏览器请求照攒);
   * 只被没有浏览器格的桌面看过 ⇒ 'none'(当场失败);还没人看过 ⇒ 'unknown'(照攒)。
   */
  let browserSeen: 'unknown' | 'some' | 'none' = 'unknown';

  const viewersOf = (sessionId: string) =>
    [...viewers.values()].filter((viewer) => viewer.sessionId === sessionId);

  const enqueue = (request: SessionpagePaneOpenRequest) => {
    const list = (queued.get(request.sessionId) ?? []).filter((entry) => !sameTarget(entry.request.target, request.target));
    list.push({ request, at: now() });
    while (list.length > MAX_QUEUED_PER_SESSION) list.shift();
    queued.delete(request.sessionId);
    queued.set(request.sessionId, list);
    while (queued.size > MAX_QUEUED_SESSIONS) {
      const oldest = queued.keys().next().value as string;
      queued.delete(oldest);
    }
  };

  const dropQueued = (requestId: string): boolean => {
    for (const [sessionId, list] of queued) {
      const rest = list.filter((entry) => entry.request.requestId !== requestId);
      if (rest.length === list.length) continue;
      if (rest.length > 0) queued.set(sessionId, rest);
      else queued.delete(sessionId);
      return true;
    }
    return false;
  };

  /** 这台机器上最近还活着的、接得住这一格的那台桌面(看着哪条会话都行)。 */
  const freshestCapable = (target: SessionpagePaneTarget): Viewer | null => {
    let best: Viewer | null = null;
    for (const viewer of viewers.values()) {
      if (canOpen(viewer, target) && (!best || viewer.seenAt > best.seenAt)) best = viewer;
    }
    return best;
  };

  const dropViewerFromWaiters = (subscriptionId: string) => {
    for (const waiter of waiters.values()) {
      if (!waiter.outstanding.delete(subscriptionId)) continue;
      // 推给它之后它走了(关掉了会话 / 被清扫):剩下没人了、也没人说过没开成 ⇒ 当成「没人看着」,攒起来等下次有人打开。
      if (waiter.outstanding.size > 0) continue;
      if (waiter.failures.length === 0) waiter.settle({ ok: false, code: 'left' });
      else waiter.settle({ ok: false, code: waiter.failures.includes('no_browser') ? 'no_browser' : 'open_failed' });
    }
  };

  return {
    subscribe(
      input: { subscriptionId: string; sessionId: string; browser: boolean; pages?: boolean; external?: boolean; tabs?: boolean },
      publish: (event: SessionpagePaneOpenEvent) => void
    ): { pending: SessionpagePaneOpenRequest[] } {
      const viewer: Viewer = { ...input, pages: input.pages === true, external: input.external === true, tabs: input.tabs === true, seenAt: now(), publish };
      viewers.set(input.subscriptionId, viewer);
      if (input.browser) browserSeen = 'some';
      else if (browserSeen === 'unknown') browserSeen = 'none';
      const fresh = (queued.get(input.sessionId) ?? []).filter((entry) => now() - entry.at <= QUEUED_TTL_MS);
      if (fresh.length > 0) queued.set(input.sessionId, fresh);
      else queued.delete(input.sessionId);
      // 交出去 ≠ 开好了:桌面回话(ack)才从攒着的里拿掉,与保活补推(touch)同一条规矩。
      // 这台桌面开不了的(浏览器请求到了没有浏览器格的桌面)不给它,等一台开得了的来。
      return { pending: fresh.filter((entry) => canOpen(viewer, entry.request.target)).map((entry) => entry.request) };
    },

    unsubscribe(subscriptionId: string): boolean {
      const had = viewers.delete(subscriptionId);
      if (had) dropViewerFromWaiters(subscriptionId);
      return had;
    },

    has(subscriptionId: string): boolean {
      return viewers.has(subscriptionId);
    },

    /** 此刻有没有桌面看着这条会话。 */
    watching(sessionId: string): boolean {
      return viewersOf(sessionId).length > 0;
    },

    /**
     * #6264 这条订阅刚被保活(桌面还活着)。它看着的会话有攒着的、它开得了的请求 ⇒ 再推一遍
     * (桌面按 requestId 去重;回话到了才从攒着的里拿掉,见 ack)。合盖醒来的那台桌面就是这样补开的。
     * 频率 = 保活频率(25 秒一次),每次只看这一条会话攒着的那几条(最多 MAX_QUEUED_PER_SESSION)。
     */
    touch(subscriptionId: string): number {
      const viewer = viewers.get(subscriptionId);
      if (!viewer) return 0;
      viewer.seenAt = now();
      const list = queued.get(viewer.sessionId) ?? [];
      const deliver = list.filter((entry) => now() - entry.at <= QUEUED_TTL_MS && canOpen(viewer, entry.request.target));
      for (const entry of deliver) {
        try {
          viewer.publish({ type: 'taskpage.pane.open', subscriptionId, request: entry.request });
        } catch (error) {
          log('pane redeliver publish failed', { subscriptionId, error: String(error) });
        }
      }
      return deliver.length;
    },

    /** 桌面回话。认不出(不是这条订阅的、已经了结的)就返回 false。 */
    ack(input: { requestId: string; subscriptionId: string; ok: boolean; failure?: SessionpagePaneFailure; error?: string } & SessionPaneTabsResult): boolean {
      const waiter = waiters.get(input.requestId);
      if (!waiter || !waiter.outstanding.has(input.subscriptionId)) {
        // 攒着的请求(订阅应答里送出去的 / 超时后攒下、保活时补推的)回话了:桌面已经开过(或如实说开不了),
        // 从攒着的里拿掉,❌ 下一台打开会话时再开一遍。
        const dropped = dropQueued(input.requestId);
        if (!dropped) log('pane ack without a waiting request', { ...input });
        return false;
      }
      if (input.ok) {
        waiter.settle({ ok: true, ...(input.tabs ? { tabs: input.tabs } : {}), ...(input.closed === undefined ? {} : { closed: input.closed }) });
        return true;
      }
      waiter.outstanding.delete(input.subscriptionId);
      waiter.failures.push(input.failure ?? 'open_failed');
      if (waiter.outstanding.size === 0) {
        waiter.settle({ ok: false, code: waiter.failures.includes('no_browser') ? 'no_browser' : 'open_failed', ...(input.error ? { error: input.error } : {}) });
      }
      return true;
    },

    async open(
      sessionId: string,
      target: SessionpagePaneTarget,
      intent: SessionpagePaneIntent,
      signal?: AbortSignal
    ): Promise<RemotePaneOutcome> {
      signal?.throwIfAborted();
      const request: SessionpagePaneOpenRequest = { requestId: newId(), sessionId, target, intent };
      let watching = viewersOf(sessionId);
      let capable = watching.filter((viewer) => canOpen(viewer, target));
      const managing = target.kind === 'tabs' || target.kind === 'close-tab';
      if (managing) {
        if (watching.length === 0) throw new Error('No Gugu window is showing this task; open it before listing or closing tabs.');
        if (capable.length === 0) throw new Error('The Gugu window showing this task is too old to list or close tabs. Update Gugu.');
        // One task may be shown on several desktops. Inspect/close on exactly one, never broadcast a close.
        capable = [capable.sort((a, b) => b.seenAt - a.seenAt)[0]!];
      }

      if (target.kind === 'external' && capable.length === 0) {
        // 这台机器上的程序要在人那一侧开网页(照 VS Code 远端的 $BROWSER):看着这条会话的桌面接不住,
        // 就交给最近还看着这台机器的那一台 —— 人在那儿;它按自己在看的会话开(requestId 不变)。
        const fallback = freshestCapable(target);
        if (fallback) {
          request.sessionId = fallback.sessionId;
          watching = [fallback];
          capable = [fallback];
        }
      }
      if (watching.length > 0 && capable.length === 0) {
        // 有浏览器格、只是太旧渲染不了这台机器上的网页 ⇒ 说「旧」,❌ 说「没有浏览器」让 agent 以为这台机器连不了网页。
        const outdated =
          target.kind === 'external' || (isRemotePageTarget(target) && watching.some((viewer) => viewer.browser));
        throw new RemotePaneError(outdated ? 'viewer_outdated' : 'no_browser');
      }
      if (watching.length === 0) {
        if (target.kind === 'browser' && browserSeen === 'none') throw new RemotePaneError('no_browser');
        if (!sessionId) throw new RemotePaneError('no_viewer');
        enqueue(request);
        return { queued: true };
      }
      const outcome = await new Promise<Settled>((resolve, reject) => {
        const timer = target.kind === 'close-tab' ? null : setTimeout(() => settle({ ok: false, code: 'viewer_timeout' }), ackTimeoutMs);
        timer?.unref?.();
        const abort = () => {
          cleanup();
          reject(signal?.reason);
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          waiters.delete(request.requestId);
          signal?.removeEventListener('abort', abort);
        };
        const settle = (result: Settled) => {
          cleanup();
          resolve(result);
        };
        waiters.set(request.requestId, {
          outstanding: new Set(capable.map((viewer) => viewer.subscriptionId)),
          failures: [],
          settle,
        });
        signal?.addEventListener('abort', abort, { once: true });
        for (const viewer of capable) {
          try {
            viewer.publish({ type: 'taskpage.pane.open', subscriptionId: viewer.subscriptionId, request });
          } catch (error) {
            log('pane open publish failed', { subscriptionId: viewer.subscriptionId, error: String(error) });
          }
        }
      });
      if (outcome.ok) return { opened: true, ...(outcome.tabs ? { tabs: outcome.tabs } : {}), ...(outcome.closed === undefined ? {} : { closed: outcome.closed }) };
      if (managing) throw new Error(outcome.error ?? (outcome.code === 'left' ? 'The Gugu window showing this task disconnected.' : describeRemotePaneFailure(outcome.code)));
      if (outcome.code === 'left') {
        enqueue(request);
        return { queued: true };
      }
      if (outcome.code === 'viewer_timeout') {
        // #6264 推出去了、没人回话:桌面多半合盖睡着了(订阅要 90 秒 + 清扫才拆)。攒着 —— 它醒来的下一次保活
        // (touch)或下一台打开会话时补开;迟到的回话会把它从攒着的里拿掉(ack)。
        log('pane open unconfirmed, queued', { requestId: request.requestId, sessionId: request.sessionId });
        enqueue(request);
        return { queued: true, unconfirmed: true };
      }
      throw new RemotePaneError(outcome.code);
    },
  };
}

let shared: RemotePaneRoute | null = null;

/** 这台机器上一份:工具那头(session-orchestration)与设备 RPC 那头(device-rpc)共用。 */
export function sharedRemotePaneRoute(): RemotePaneRoute {
  return (shared ??= createRemotePaneRoute());
}
