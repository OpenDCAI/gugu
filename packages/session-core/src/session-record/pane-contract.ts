/**
 * #6264 别的机器上的会话调 `session_open_in_tab`:那台机器没有窗口,tab 要开在**正看着这条会话的那台桌面**的
 * 右侧工作区里。走的是到那台机器会话页宿主的那条连接(`SESSION_HOST_PANE`,host-ws/device-pane-relay.ts):
 * 桌面看着这条会话时订阅,机器推一条打开请求,桌面开完回一声,机器据此答 agent。❌ 把「推出去了」当成功。
 *
 * ⚠️ 这个文件要能进浏览器:❌ import 任何带 node 依赖的模块。
 */

/**
 * agent 要开的东西。路径是**那台机器上的绝对路径**,且落在会话的工作目录里(机器那边先核过)。
 * `external`:那台机器上的程序要「打开网页」(`$BROWSER` / `xdg-open`,如 `gh auth login --web`)——
 * 照 VS Code 远端的 openExternal,在**人这一侧**打开(桌面决定开进会话的浏览器格还是系统浏览器)。
 */
export type SessionpagePaneTarget =
  | { kind: 'file'; path: string }
  | { kind: 'browser'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'tabs' }
  | { kind: 'close-tab'; tabId: string };

/** Live renderer state, including tabs in detached windows of this task. */
export type SessionPaneTab = { tab_id: string; title: string; kind: string; closable: boolean };
export type SessionPaneTabsResult = { tabs?: SessionPaneTab[]; closed?: boolean };

export function isSessionPaneTabs(value: unknown): value is SessionPaneTab[] {
  return Array.isArray(value) && value.every((tab) => isRecord(tab)
    && typeof tab.tab_id === 'string' && typeof tab.title === 'string'
    && typeof tab.kind === 'string' && typeof tab.closable === 'boolean');
}

export type SessionpagePaneIntent = 'preview' | 'pinned';

export type SessionpagePaneOpenRequest = {
  requestId: string;
  sessionId: string;
  target: SessionpagePaneTarget;
  intent: SessionpagePaneIntent;
};

/**
 * 桌面没开成的原因(闭集,机器据此给 agent 一句能照着做的话):
 *  · `no_browser`  这台桌面上这条会话没有浏览器格(那台机器只经远程隧道连着);
 *  · `open_failed` 开的时候出错了(细节只进桌面日志)。
 */
export type SessionpagePaneFailure = 'no_browser' | 'open_failed';

/** 机器 → 桌面的推送(广播,无 request_id,带 subscriptionId,只有那一条订阅照办)。 */
export type SessionpagePaneOpenEvent = {
  type: 'taskpage.pane.open';
  subscriptionId: string;
  request: SessionpagePaneOpenRequest;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSessionpagePaneTarget(value: unknown): value is SessionpagePaneTarget {
  if (!isRecord(value)) return false;
  if (value.kind === 'file') return typeof value.path === 'string' && value.path.length > 0;
  if (value.kind === 'tabs') return true;
  if (value.kind === 'close-tab') return typeof value.tabId === 'string' && value.tabId.length > 0;
  if (value.kind === 'browser' || value.kind === 'external') return typeof value.url === 'string' && value.url.length > 0;
  return false;
}

function isSessionpagePaneOpenRequest(value: unknown): value is SessionpagePaneOpenRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === 'string' &&
    typeof value.sessionId === 'string' &&
    (value.intent === 'preview' || value.intent === 'pinned') &&
    isSessionpagePaneTarget(value.target)
  );
}

export function isSessionpagePaneOpenEvent(value: unknown): value is SessionpagePaneOpenEvent {
  if (!isRecord(value)) return false;
  return (
    value.type === 'taskpage.pane.open' &&
    typeof value.subscriptionId === 'string' &&
    isSessionpagePaneOpenRequest(value.request)
  );
}
