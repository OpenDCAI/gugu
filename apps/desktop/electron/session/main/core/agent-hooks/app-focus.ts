import { BrowserWindow } from 'electron';

/**
 * 有没有窗口在最前面。
 *
 * ⚠️ 这**只能**用来喂「提示音」那一路(用户可以在任务设置里显式选「只在未聚焦时响」)。
 * ❌ 别拿它门控系统通知 —— 焦点说明窗口在最前面,不说明人在电脑前;当作「用户已经看见了」
 * 的证据,人离开时该响的就不响(owner 2026-09-09 定,见 notification.ts 与
 * tests/unit/domain/notifications/notificationFocusGate-5301.test.ts)。
 */
export function isAppFocused(): boolean {
  const windows = BrowserWindow.getAllWindows();
  return windows.some((w) => !w.isDestroyed() && w.isFocused());
}
