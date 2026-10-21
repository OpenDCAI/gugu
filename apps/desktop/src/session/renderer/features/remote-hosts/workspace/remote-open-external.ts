// #6264 那台机器上的程序要「打开网页」($BROWSER / xdg-open,如 `gh auth login --web`、`vite --open`、codex 的登录页):
// 照 VS Code 远端的 openExternal,在人这一侧打开。落在哪:
//  · 网址本身是那台机器的 localhost ⇒ 这条会话的浏览器格(页签自己经 SSH 转端口);只经云端连着的机器开不了,如实说;
//  · 别的网址 ⇒ 这条会话的工作区里开着浏览器页签就开在那里,否则这台电脑的系统浏览器(人平时的登录都在那儿);
//  · 网址里带着「登录完跳回 localhost:端口」⇒ 那个端口顺手转过来、同号(VS Code 1.88「Port forwarding in query」),
//    登录页跳回来时才落得到那台机器上。转发留一段时间(够人登录完)再放手。
import type { SessionpagePaneOpenRequest } from '@gugu/session-core/session-record/contract';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { LOGIN_PORT_HOLDER_PREFIX } from '@shared/remote-ports';
import { remoteHostsStore } from '../remote-hosts-store';
import type { PaneOpenResult } from './remote-pane-viewer';
import { loginCallbackPorts } from './remote-ports-model';
import { remoteLoopbackPort } from './remote-workspace-routing';

/** 登录回调的转发留多久:够人在浏览器里登录完(VS Code 的做法是一直留到会话结束;我们按一次登录算)。 */
export const LOGIN_FORWARD_MS = 15 * 60_000;

export type ExternalOpenTarget = {
  readonly deviceId: string;
  readonly sessionId: string;
  hasBrowserTab(): boolean;
  openInBrowserTab(url: string): void;
};

export type ExternalOpenDeps = {
  openSystemBrowser: (url: string) => void;
  /** 同号转过来;`busy` = 这台电脑上同号端口被别的程序占着(不换号:回跳会落到它身上)。 */
  forward: (input: { deviceId: string; sessionId: string; remotePort: number; holder: string }) => Promise<'ok' | 'busy' | 'failed'>;
  release: (input: { deviceId: string; remotePort: number; holder: string }, afterMs: number) => void;
  tell: (message: string) => void;
  deviceLabel: (deviceId: string) => string;
};

const defaultDeps: ExternalOpenDeps = {
  openSystemBrowser: (url) =>
    void rpc.app.openExternal(url).catch((error: unknown) => log.warn('[remote-open] system browser failed', { error: String(error) })),
  forward: (input) =>
    rpc.remotePorts
      .open({ ...input, exactLocalPort: true })
      .then((result) => {
        if (result.success) return 'ok' as const;
        log.warn('[remote-open] login callback port not forwarded', { ...input, error: result.error });
        return result.error.type === 'failed' && result.error.reason === 'local-port-busy' ? ('busy' as const) : ('failed' as const);
      })
      .catch(() => 'failed' as const),
  release: (input, afterMs) => {
    setTimeout(() => void rpc.remotePorts.release(input).catch(() => undefined), afterMs);
  },
  tell: (message) => toast({ title: message, tier: 'warning' }),
  deviceLabel: (deviceId) => remoteHostsStore.device(deviceId)?.label ?? deviceId,
};

export function openExternalFromMachine(
  target: ExternalOpenTarget,
  input: { url: string; requestId: SessionpagePaneOpenRequest['requestId']; browser: boolean },
  deps: ExternalOpenDeps = defaultDeps
): PaneOpenResult {
  const device = deps.deviceLabel(target.deviceId);
  if (remoteLoopbackPort(input.url) !== null) {
    if (!input.browser) {
      deps.tell(translateSessionMessage('remotePorts.tunnelLoopback', { device }));
      return { ok: false, failure: 'no_browser' };
    }
    target.openInBrowserTab(input.url);
    return { ok: true };
  }
  const callbacks = loginCallbackPorts(input.url);
  if (callbacks.length > 0) {
    if (input.browser) {
      const holder = `${LOGIN_PORT_HOLDER_PREFIX}${input.requestId}`;
      for (const remotePort of callbacks) {
        void deps
          .forward({ deviceId: target.deviceId, sessionId: target.sessionId, remotePort, holder })
          .then((outcome) => {
            if (outcome === 'busy') deps.tell(translateSessionMessage('remotePorts.localPortBusy', { port: remotePort }));
          });
        deps.release({ deviceId: target.deviceId, remotePort, holder }, LOGIN_FORWARD_MS);
      }
    } else {
      deps.tell(translateSessionMessage('remotePorts.tunnelLoginCallback', { device }));
    }
  }
  if (input.browser && target.hasBrowserTab()) target.openInBrowserTab(input.url);
  else deps.openSystemBrowser(input.url);
  return { ok: true };
}
