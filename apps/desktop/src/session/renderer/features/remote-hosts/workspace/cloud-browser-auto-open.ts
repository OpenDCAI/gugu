// #7199 server 上的 agent 开了浏览器:人正看着那台机器上的会话,就把「浏览器」页签开出来(画面、接管都在那里;
// 聊天页不再浮小窗,owner 10-28)。只看主窗正显示的那一条(viewedMachineSession);一次浏览开一次 ——
// 人把页签关了就不再硬塞回来,直到浏览器关了再开(或它又来求人)。
// 只在看着一条 server 上的会话时问那台机器(原先聊天里小窗的同一节奏),❌ 没人看也问。
import { reaction } from 'mobx';
import { cloudHostSuspended } from '@/lib/cloudHostSuspended';
import { fetchCloudBrowserStatus } from '@/lib/cloudBrowser';
import type { CloudBrowserStatus } from '@shared/cloud-browser';
import { log } from '@renderer/utils/logger';

const POLL_MS = 4_000;
/** agent 这么久没碰浏览器(也没人接管)= 不算「正在用」,❌ 一打开会话就弹出一个早就用完的浏览器。 */
const RECENT_MS = 30 * 60_000;

export type CloudBrowserSessionRef = { deviceId: string; projectId: string; sessionId: string };

/** 这一刻该不该把页签开出来(纯函数,单测钉)。`opened` = 这一次浏览里这条会话已经开过。 */
export function shouldOpenCloudBrowserTab(status: CloudBrowserStatus | null, now: number, opened: boolean, hasTab: boolean): boolean {
  if (!status?.available || !status.running || status.tabs.length === 0) return false;
  if (opened || hasTab) return false;
  if (status.controlled || status.automation === 'stopped') return true;
  const last = status.lastActivityAt ? Date.parse(status.lastActivityAt) : NaN;
  return Number.isFinite(last) && now - last <= RECENT_MS;
}

export function installCloudBrowserAutoOpen(deps: {
  viewed: () => CloudBrowserSessionRef | null;
  isServer: (deviceId: string) => boolean;
  hasTab: (session: CloudBrowserSessionRef) => boolean;
  /** 开出来了 = true;会话页还没准备好 = false(下一拍再试)。 */
  open: (session: CloudBrowserSessionRef) => boolean;
}): void {
  /** 这一次浏览里已经开过的会话(浏览器关了就清掉,下一次再开)。 */
  const opened = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const tick = async (session: CloudBrowserSessionRef, mine: number) => {
    if (mine !== generation) return;
    if (!cloudHostSuspended(session.deviceId)) {
      try {
        const status = await fetchCloudBrowserStatus(session.deviceId);
        if (mine !== generation) return;
        const done = opened.get(session.deviceId) ?? new Set<string>();
        if (!status.running) done.clear();
        const key = `${session.projectId}/${session.sessionId}`;
        if (shouldOpenCloudBrowserTab(status, Date.now(), done.has(key), deps.hasTab(session))) {
          if (deps.open(session)) done.add(key);
        } else if (deps.hasTab(session)) {
          done.add(key);
        }
        opened.set(session.deviceId, done);
      } catch (error) {
        log.debug('[cloud-browser-auto-open] status failed', { deviceId: session.deviceId, error: String(error) });
      }
    }
    if (mine === generation) timer = setTimeout(() => void tick(session, mine), POLL_MS);
  };

  reaction(
    () => {
      const viewed = deps.viewed();
      return viewed && deps.isServer(viewed.deviceId) ? `${viewed.deviceId}\n${viewed.projectId}\n${viewed.sessionId}` : null;
    },
    (key) => {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!key) return;
      const [deviceId, projectId, sessionId] = key.split('\n');
      void tick({ deviceId, projectId, sessionId }, generation);
    },
    { fireImmediately: true }
  );
}
