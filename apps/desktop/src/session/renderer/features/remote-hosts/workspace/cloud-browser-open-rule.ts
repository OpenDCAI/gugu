// #7199 「浏览器」页签什么时候自己开出来(纯函数;装配见 cloud-browser-auto-open.ts)。
import type { CloudBrowserStatus } from '@shared/cloud-browser';

/** agent 这么久没碰浏览器(也没人接管)= 不算「正在用」,❌ 一打开会话就弹出一个早就用完的浏览器。 */
const RECENT_MS = 30 * 60_000;

/** 这一刻该不该把页签开出来(纯函数,单测钉)。`opened` = 这一次浏览里这条会话已经开过。 */
export function shouldOpenCloudBrowserTab(status: CloudBrowserStatus | null, now: number, opened: boolean, hasTab: boolean): boolean {
  if (!status?.available || !status.running || status.tabs.length === 0) return false;
  if (opened || hasTab) return false;
  if (status.controlled || status.automation === 'stopped') return true;
  const last = status.lastActivityAt ? Date.parse(status.lastActivityAt) : NaN;
  return Number.isFinite(last) && now - last <= RECENT_MS;
}
