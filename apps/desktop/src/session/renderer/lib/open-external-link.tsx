import { messageForUser } from '@/lib/userFacingError';
import { log } from '@renderer/utils/logger';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { normalizeExternalHttpUrl } from './external-url';
import { activeRemoteLinkTarget } from './remote-link-target';

const HTTP_URL_PATTERN = /^https?:\/\//i;

export function confirmOpenExternalLink(url: string, onError?: (error: unknown) => void): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);

  if (!HTTP_URL_PATTERN.test(normalizedUrl)) {
    return;
  }

  // #6264 别的机器上的会话里点的 localhost 链接:开进那条会话的浏览器格(经 SSH 转到那台机器),❌ 开到这台电脑自己的端口。
  const remote = activeRemoteLinkTarget();
  if (remote?.claimLoopback(normalizedUrl)) return;

  const sessionView = getActiveSessionView();

  showModal('confirmExternalLinkModal', {
    url: normalizedUrl,
    canOpenInEmdashBrowser: sessionView !== undefined || remote?.canOpenInBrowserTab === true,
    onCopy: () => copyExternalLink(normalizedUrl),
    onSuccess: (choice) => {
      if (choice === 'emdash-browser' && !sessionView && remote) {
        remote.openInBrowserTab(normalizedUrl);
        return;
      }
      if (choice === 'emdash-browser') {
        sessionView?.paneLayout.open('browser', { initialUrl: normalizedUrl });
        sessionView?.setFocusedRegion('main');
        return;
      }
      void rpc.app.openExternal(normalizedUrl).catch((error) => {
        onError?.(error);
      });
    },
  });
}

/**
 * 不经「打开链接?」确认、直接在系统浏览器里开 —— 只给**人刚在界面上点了「在浏览器中打开」**的那一下用
 * (那一下本身就是确认,链接全文就摆在他眼前)。
 *
 * ⚠️ 为什么不能走 `confirmOpenExternalLink`:它用的是全局唯一的那个弹窗位,弹出来就把**当前**弹窗换掉。
 * 登录窗口里弹它,登录窗口就被顶没了 —— 点「取消」整个登录窗口跟着消失,而那台机器上的登录命令还在跑
 * (#6264 走查实撞)。
 */
export function openExternalLinkInBrowser(url: string, onError?: (error: unknown) => void): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);
  if (!HTTP_URL_PATTERN.test(normalizedUrl)) return;
  void rpc.app.openExternal(normalizedUrl).catch((error) => {
    onError?.(error);
  });
}

export async function copyExternalLink(url: string, done = translateSessionMessage('externalLink.linkCopied')): Promise<boolean> {
  try {
    await rpc.app.clipboardWriteText(url);
    toast({ title: done });
    return true;
  } catch (error) {
    log.error('clipboard copy failed', { error });
    toast({ title: translateSessionMessage('externalLink.copyFailed'), description: messageForUser(error), variant: 'destructive' });
    return false;
  }
}


function getActiveSessionView() {
  if (appState.navigation.currentViewId !== 'session') return undefined;
  const params = appState.navigation.viewParamsStore.session;
  const projectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
  if (!projectId || !sessionId) return undefined;
  return getSessionView(projectId, sessionId);
}
