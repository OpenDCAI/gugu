import { rpc } from '@renderer/lib/ipc';

/**
 * #7274 网页是窗口里独立的一个 view:人点进网页后,窗口焦点在它那边,界面这一层的 JS `focus()` 只在界面自己那棵树里挪,
 * 挪不回窗口焦点 —— 人在网页里按 ⌘K、点了界面上的「聚焦地址栏」,光标看着到了输入框,字却还落进网页。
 * 所以界面要聚焦自己的元素、而此刻窗口焦点在网页上时,先请主进程把窗口焦点交回界面(VS Code 内置浏览器同一个补法,
 * microsoft/vscode#287907)。原先 `<webview>` 嵌在界面里,界面 `focus()` 自然能把焦点从它那里拿回来 —— 这里补回同样的行为。
 */

/** 此刻拿着窗口焦点的网页:browserId → 它所在那扇窗的名字(主进程报 focus / blur)。 */
const focusedPages = new Map<string, string>();

export function notePageFocus(browserId: string, windowName: string, focused: boolean): void {
  if (focused) focusedPages.set(browserId, windowName);
  else if (focusedPages.get(browserId) === windowName) focusedPages.delete(browserId);
}

export function forgetPageFocus(browserId: string): void {
  focusedPages.delete(browserId);
}

function pageHoldsFocusIn(windowName: string): boolean {
  for (const name of focusedPages.values()) if (name === windowName) return true;
  return false;
}

const guarded = new WeakSet<Window>();

/** 给这扇窗的界面装上(幂等):主窗、挪去单独成窗的那几扇,各装一次。 */
export function guardHostFocus(win: Window): void {
  if (guarded.has(win)) return;
  guarded.add(win);
  const proto = (win as Window & typeof globalThis).HTMLElement.prototype;
  const original = proto.focus;
  proto.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    // 聚焦的是网页的占位本身(点了页签 → 焦点交给网页):不必先拿回来。
    if (!this.hasAttribute('data-browser-page')) {
      const windowName = this.ownerDocument.defaultView?.name ?? '';
      if (pageHoldsFocusIn(windowName)) void rpc.browser.focusHost(windowName);
    }
    return original.call(this, options);
  };
}
