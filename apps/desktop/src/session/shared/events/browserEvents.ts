import { defineEvent } from '@shared/lib/ipc/events';

export const browserOpenInNewTabChannel = defineEvent<{
  sourceBrowserId: string;
  url: string;
}>('browser:open-in-new-tab');

/**
 * 用户点进了这个网页。点进网页的按下、聚焦都发生在网页自己的进程里,咕咕的界面收不到,
 * 只有主进程看得见 —— 两个网页并排时靠它让页签的焦点跟到点的那一边(spec session-page「并排」)。
 */
export const browserFocusedChannel = defineEvent<{ browserId: string }>('browser:focused');

/**
 * #7191 会话里的 agent 在不在操作这个页签。`driving` = 正在执行一个浏览器动作;`paused` = 人接管了
 * (点进了页面或按了「停止」),agent 的动作被拒到人说继续为止;`idle` = 没在操作。
 * 页签据此画「agent 正在操作」条,并在它被切到后台时仍保持绘制(否则截图、点击会卡住)。
 */
export type BrowserAgentState = 'driving' | 'paused' | 'idle';
export const browserAgentStateChannel = defineEvent<{ browserId: string; state: BrowserAgentState }>(
  'browser:agent-state'
);

/**
 * #7191 agent 的鼠标。坐标是页签里网页区域的 CSS 像素(主进程已乘上网页缩放),取自 Playwright 发给网页的真实输入。
 * `move`:页签把 agent 的鼠标移过去,到了回 `browser.agentCursorArrived(moveId)` —— 主进程等到这一声才把这一下交给网页,
 * 人看见鼠标先到、再点。`target` 是要落进去的那一块(打字的输入框),给动画算时长用。`click`:在鼠标所在处画一下点击。
 */
export type BrowserAgentCursorEvent =
  | {
      browserId: string;
      kind: 'move';
      moveId: number;
      x: number;
      y: number;
      target: [x: number, y: number, width: number, height: number] | null;
    }
  | { browserId: string; kind: 'click' };
export const browserAgentCursorChannel = defineEvent<BrowserAgentCursorEvent>('browser:agent-cursor');

/**
 * #7274 页签里那张网页此刻的导航状态,随每一条网页事件一起报(网页是主进程持有的 WebContentsView,页签那边
 * 读不到它,只能照这一份画地址栏、前进后退)。
 */
export type BrowserPageState = { url: string; title: string; canGoBack: boolean; canGoForward: boolean };
export type BrowserPageEventType =
  | 'dom-ready'
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'did-fail-load'
  | 'console-message'
  | 'page-title-updated'
  | 'page-favicon-updated'
  | 'focus'
  | 'blur';
export type BrowserPageEvent = {
  browserId: string;
  type: BrowserPageEventType;
  /** 与原先 `<webview>` 同名事件上的字段一样(url、errorCode、title、favicons…)。 */
  detail: Record<string, unknown>;
  state: BrowserPageState;
};
export const browserPageEventChannel = defineEvent<BrowserPageEvent>('browser:page-event');

/**
 * #7274 页签里网页那一块此刻的样子:`shown` 露在屏上;`occluded` 页签在屏上、但咕咕自己的浮层(菜单、弹窗、
 * 起始页…)压在它上面 —— 网页画在界面之上,这时得让开、换成一张截图;`background` 不在屏上(后台页签、别的会话)。
 */
export type BrowserPageMode = 'shown' | 'occluded' | 'background';

export const browserLinkCopiedChannel = defineEvent<{
  kind: 'image' | 'link' | 'url';
  url: string;
}>('browser:link-copied');
