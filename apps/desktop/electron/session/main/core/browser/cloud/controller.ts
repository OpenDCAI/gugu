import { err, ok } from '@gugu/session-shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { CloudBrowserStatus } from '@shared/cloud-browser';
import { cloudBrowser, isCloudBrowserHost } from './cloud-browser';
import { cloudBrowserLive } from './live-server';

/**
 * #7199 云浏览器的状态与小图:别的电脑 / 手机经会话页宿主(`taskhost.call`,设备 RPC)问这台云电脑。
 * 桌面自己(不是咕咕 server)答「没有」—— 云浏览器只在云电脑上。
 */
const NONE: CloudBrowserStatus = {
  available: false,
  running: false,
  tabs: [],
  activeTabId: null,
  automation: 'idle',
  completed: false,
  controlled: false,
  lastActivityAt: null,
  assistance: null,
  live: null,
};

export const cloudBrowserController = createRPCController({
  status: async () => {
    if (!isCloudBrowserHost()) return ok(NONE);
    const browser = cloudBrowser();
    if (!browser.hub()) return ok(browser.status(null));
    return ok(browser.status(await cloudBrowserLive().ensure()));
  },

  snapshot: async (args?: { tabId?: string | null; maxWidth?: number }) => {
    if (!isCloudBrowserHost()) return err({ type: 'unavailable' as const });
    const maxWidth = typeof args?.maxWidth === 'number' && args.maxWidth >= 120 && args.maxWidth <= 1280 ? Math.round(args.maxWidth) : 480;
    const shot = await cloudBrowserLive().snapshot(typeof args?.tabId === 'string' ? args.tabId : null, maxWidth);
    return shot ? ok(shot) : err({ type: 'none' as const });
  },
});
