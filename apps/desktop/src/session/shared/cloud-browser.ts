// #7199 云浏览器:云电脑上的咕咕 server ↔ 看它的桌面 / 手机之间的契约。
//
// 两条线:
//   · 状态与小图走会话页宿主的 `cloudBrowser.*`(设备 RPC,桌面手机都通,见 core/browser/cloud/controller.ts);
//   · 实时画面、接管、输入、密码保险箱走一条 websocket(只在云电脑本机回环上开,桌面经远程隧道转一个本机端口过去,
//     SSH 端到端加密 —— 密码只走这条)。消息名:frame / control_acquire / input_mouse …。

export const CLOUD_BROWSER_PROTOCOL = 'gugu-browser-v1';
/** 凭证放在 websocket 子协议里(❌ 进网址:网址会进日志)。 */
export const CLOUD_BROWSER_TICKET_PREFIX = 'gugu-browser-ticket.';

export type CloudBrowserTab = { tabId: string; title: string; url: string; byAgent: boolean };
export type CloudBrowserAutomation = 'idle' | 'running' | 'stopped';
export type CloudBrowserControl = 'released' | 'pending' | 'granted' | 'occupied';
/** agent 在等人:登录(密码保险箱)或接手一步(验证码、短信码)。 */
export type CloudBrowserAssistance = {
  requestId: string;
  kind: 'login' | 'takeover';
  site?: string;
  url?: string;
  text?: string;
};

export type CloudBrowserStatus = {
  /** 这台机器上有 Chrome、能用云浏览器。 */
  available: boolean;
  /** Chrome 此刻开着。 */
  running: boolean;
  /** 开过、后来关了(云电脑睡了 / 最后一个页签被关)。 */
  ended?: boolean;
  tabs: CloudBrowserTab[];
  activeTabId: string | null;
  automation: CloudBrowserAutomation;
  completed: boolean;
  /** 有人接管着(或在等接管)。 */
  controlled: boolean;
  lastActivityAt: string | null;
  /** 只有协议 12 的 server 报(13 起求助是会话上的 Ask,见 useCloudBrowser 的向下兼容)。 */
  assistance?: CloudBrowserAssistance | null;
  /** 实时画面那条 websocket 在云电脑本机哪个端口、凭什么连;Chrome 没开 = null。 */
  live: { port: number; token: string } | null;
};

export type CloudBrowserSnapshot = {
  tabId: string;
  data: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type CloudBrowserState = {
  type: 'state';
  running: boolean;
  tabs: CloudBrowserTab[];
  activeTabId: string | null;
  automation: CloudBrowserAutomation;
  completed: boolean;
  control: CloudBrowserControl;
};

export type CloudBrowserServerMessage =
  | CloudBrowserState
  | {
      type: 'frame';
      seq: number;
      tabId: string;
      data: string;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  | { type: 'tab_close_result'; tabId: string; closed: boolean }
  | { type: 'input_result'; id: string; ok: boolean }
  | { type: 'vault_result'; requestId: string; ok: boolean; reason?: 'gone' | 'noForm' | 'saveFailed' }
  | { type: 'error'; code: string; message: string };

export type CloudBrowserMouseEvent = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type CloudBrowserMouseButton = 'none' | 'left' | 'middle' | 'right';

export type CloudBrowserClientMessage =
  | { type: 'config'; framesEnabled: boolean; maxFps: number; maxWidth: number; maxHeight: number; tabId: string | null }
  | { type: 'ack'; seq: number }
  | { type: 'keepalive' }
  | { type: 'control_acquire' }
  | { type: 'control_release' }
  | { type: 'automation_stop' }
  | { type: 'automation_resume' }
  | { type: 'tab_select'; tabId: string }
  | { type: 'tab_close'; tabId: string }
  | {
      type: 'input_mouse';
      eventType: CloudBrowserMouseEvent;
      x: number;
      y: number;
      button: CloudBrowserMouseButton;
      buttons: number;
      clickCount: number;
      modifiers: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      type: 'input_keyboard';
      eventType: 'keyDown' | 'keyUp';
      key: string;
      code: string;
      windowsVirtualKeyCode: number;
      modifiers: number;
      text?: string;
    }
  | { type: 'input_text'; id: string; text: string }
  | { type: 'vault_submit'; requestId: string; username: string; password: string; save: boolean };

/** 一段文字一次最多发这么多(4096 字);更长的分块发。 */
export const CLOUD_BROWSER_TEXT_CHUNK = 4096;
/** 客户端一条消息的上限(字节);密码、文字都远小于它。 */
export const CLOUD_BROWSER_CLIENT_MESSAGE_MAX = 16 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const MOUSE_EVENTS = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right']);

/** 含 \0 或落单的代理项 = 不能交给网页的文字(「文本包含不支持的字符」)。 */
export function isSendableText(text: string): boolean {
  if (text.includes('\0')) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** 服务端收到的一条:认得、字段齐全才放行;否则 null(❌ 猜着用)。 */
export function parseCloudBrowserClientMessage(raw: string): CloudBrowserClientMessage | null {
  if (raw.length > CLOUD_BROWSER_CLIENT_MESSAGE_MAX) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'config':
      if (typeof value.framesEnabled !== 'boolean' || !isInt(value.maxFps, 1, 30) || !isInt(value.maxWidth, 64, 4096) || !isInt(value.maxHeight, 64, 4096)) return null;
      if (value.tabId !== null && !isId(value.tabId)) return null;
      return { type: 'config', framesEnabled: value.framesEnabled, maxFps: value.maxFps, maxWidth: value.maxWidth, maxHeight: value.maxHeight, tabId: value.tabId as string | null };
    case 'ack':
      return isInt(value.seq, 0, Number.MAX_SAFE_INTEGER) ? { type: 'ack', seq: value.seq } : null;
    case 'keepalive':
    case 'control_acquire':
    case 'control_release':
    case 'automation_stop':
    case 'automation_resume':
      return { type: value.type };
    case 'tab_select':
    case 'tab_close':
      return isId(value.tabId) ? { type: value.type, tabId: value.tabId } : null;
    case 'input_mouse': {
      if (typeof value.eventType !== 'string' || !MOUSE_EVENTS.has(value.eventType)) return null;
      if (typeof value.button !== 'string' || !MOUSE_BUTTONS.has(value.button)) return null;
      if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isInt(value.buttons, 0, 31) || !isInt(value.clickCount, 0, 3) || !isInt(value.modifiers, 0, 15)) return null;
      const deltaX = isFiniteNumber(value.deltaX) ? Math.max(-1e5, Math.min(1e5, value.deltaX)) : undefined;
      const deltaY = isFiniteNumber(value.deltaY) ? Math.max(-1e5, Math.min(1e5, value.deltaY)) : undefined;
      return {
        type: 'input_mouse',
        eventType: value.eventType as CloudBrowserMouseEvent,
        x: value.x,
        y: value.y,
        button: value.button as CloudBrowserMouseButton,
        buttons: value.buttons,
        clickCount: value.clickCount,
        modifiers: value.modifiers,
        ...(deltaX !== undefined ? { deltaX } : {}),
        ...(deltaY !== undefined ? { deltaY } : {}),
      };
    }
    case 'input_keyboard': {
      if (value.eventType !== 'keyDown' && value.eventType !== 'keyUp') return null;
      if (typeof value.key !== 'string' || value.key.length > 32 || typeof value.code !== 'string' || value.code.length > 32) return null;
      if (!isInt(value.windowsVirtualKeyCode, 0, 255) || !isInt(value.modifiers, 0, 15)) return null;
      const text = typeof value.text === 'string' && value.text.length <= 4 && isSendableText(value.text) ? value.text : undefined;
      return { type: 'input_keyboard', eventType: value.eventType, key: value.key, code: value.code, windowsVirtualKeyCode: value.windowsVirtualKeyCode, modifiers: value.modifiers, ...(text ? { text } : {}) };
    }
    case 'input_text':
      if (!isId(value.id) || typeof value.text !== 'string' || value.text.length === 0 || value.text.length > CLOUD_BROWSER_TEXT_CHUNK || !isSendableText(value.text)) return null;
      return { type: 'input_text', id: value.id, text: value.text };
    case 'vault_submit':
      if (!isId(value.requestId) || typeof value.username !== 'string' || typeof value.password !== 'string' || typeof value.save !== 'boolean') return null;
      if (value.username.length > 512 || value.password.length > 1024 || (!value.username && !value.password)) return null;
      return { type: 'vault_submit', requestId: value.requestId, username: value.username, password: value.password, save: value.save };
    default:
      return null;
  }
}

/** 桌面收到的一条:不认得的类型静默丢(新版服务端多发的);认得但格式坏 = null。 */
export function parseCloudBrowserServerMessage(raw: string): CloudBrowserServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'state':
      if (!Array.isArray(value.tabs) || typeof value.running !== 'boolean' || typeof value.completed !== 'boolean') return null;
      return value as unknown as CloudBrowserState;
    case 'frame':
      if (!isInt(value.seq, 0, Number.MAX_SAFE_INTEGER) || !isId(value.tabId) || typeof value.data !== 'string') return null;
      if (!isInt(value.width, 1, 100_000) || !isInt(value.height, 1, 100_000) || !isFiniteNumber(value.viewportWidth) || !isFiniteNumber(value.viewportHeight)) return null;
      return value as unknown as CloudBrowserServerMessage;
    case 'tab_close_result':
    case 'input_result':
    case 'vault_result':
    case 'error':
      return value as unknown as CloudBrowserServerMessage;
    default:
      return null;
  }
}

/** 修饰键位:alt=1 ctrl=2 meta=4 shift=8(= CDP Input 的 modifiers)。 */
export function modifierBits(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
