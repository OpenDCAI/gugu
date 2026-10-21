import { app, webContents, type WebContents } from 'electron';
import {
  isBrowserPartition,
  type WebviewAttachParams,
  type WebviewPreferences,
} from '@main/core/browser/webview-security';
import {
  hardenExtensionWebviewPreferences,
  isAllowedExtensionNavigation,
  stripExtensionWebviewParams,
  validateExtensionWebviewAttach,
} from '@main/core/extensions/extension-webview-security';
import {
  extensionBridgePreloadCandidates,
  resolveExtensionBridgePreload,
} from '@main/core/extensions/bridge-preload-path';
import { configuredExtensionIds, extensionIdForSession } from '@main/core/extensions/extension-session';
import { log } from '@main/lib/logger';
import { extensionIdFromPartition } from '@shared/extensions/partition';

/** Where the bridge preload landed in this build, or null if it did not — see bridge-preload-path.ts. */
function extensionBridgePreloadPath(): string | null {
  return resolveExtensionBridgePreload(__dirname);
}

/**
 * Admission control for every <webview> in the app.
 *
 * Registered against the app rather than a window: the policy is about what may
 * be embedded anywhere, and the window it used to hang off
 * (`createMainWindow`) stopped being called when the session page was merged into
 * gugu (#2802) — so the rules had been unenforced ever since. Attaching to the
 * app covers windows created before and after this call, in any order. Refs #2374.
 */

const governed = new WeakSet<WebContents>();

let appListenerInstalled = false;

/**
 * Idempotent so it can be installed at the earliest point that always runs —
 * the host installs it when it loads this module, and boot repeats it. A policy
 * that only existed if an optional boot succeeded would turn deny-by-default
 * into allow-by-default precisely when something had already gone wrong.
 */
export function registerWebviewAttachPolicy(): void {
  for (const contents of webContents.getAllWebContents()) governWebContents(contents);
  if (appListenerInstalled) return;
  appListenerInstalled = true;
  app.on('web-contents-created', (_event, contents) => governWebContents(contents));
}

/**
 * Applies the policy to one embedder. Idempotent: `will-attach-webview` only
 * fires on webContents that actually host a <webview>, so governing every
 * webContents costs nothing on the ones that never will.
 */
export function governWebContents(contents: WebContents): void {
  if (governed.has(contents)) return;
  governed.add(contents);
  contents.on('will-attach-webview', handleWillAttachWebview);
  contents.on('did-attach-webview', (_event, attached) => handleDidAttachWebview(attached));
}

function handleWillAttachWebview(
  event: { preventDefault(): void },
  webPreferences: WebviewPreferences,
  params: WebviewAttachParams
): void {
  const partition = typeof params.partition === 'string' ? params.partition : '';

  if (isBrowserPartition(partition)) {
    // #7274 浏览器页签的网页由主进程自己建(WebContentsView,browser-page-views.ts),不再是 <webview>。
    // 谁再拿浏览器配置的分区挂 <webview>,一律拒:那份登录只交给主进程建、收紧过的网页。
    event.preventDefault();
    log.warn('Denied webview on a browser partition: browser pages are main-process views now');
    return;
  }

  if (extensionIdFromPartition(partition)) {
    const validation = validateExtensionWebviewAttach(params, configuredExtensionIds());
    if (!validation.ok) {
      event.preventDefault();
      log.warn('Denied extension webview attachment', { reason: validation.reason });
      return;
    }
    hardenExtensionWebviewPreferences(webPreferences);
    stripExtensionWebviewParams(params);
    // The bridge, and only now: hardening deletes whatever preload the renderer
    // asked for precisely so that *this* line is the one that decides. A preload
    // runs with more authority than the page, so which script that is has to be
    // the main process's choice, not a field in an attach request.
    const bridge = extensionBridgePreloadPath();
    if (!bridge) {
      // ❌ 不静默降级:少了桥,扩展会以「装上了却什么都不响应」的样子出现,而那是
      // 打包出的错。拒绝并大声报,好过画一个半死的面、让人去查扩展本身。
      event.preventDefault();
      log.error('Refusing extension webview: bridge preload is missing from this build', {
        searched: extensionBridgePreloadCandidates(__dirname),
      });
      return;
    }
    webPreferences.preload = bridge;
    return;
  }

  // Neither surface claims this partition, so nothing in the app is asking for
  // it. Refusing by default keeps a new embedding path from inheriting the
  // renderer's authority just because nobody wrote a rule for it yet.
  event.preventDefault();
  log.warn('Denied webview attachment for an unrecognised partition', {
    partition: partition || '<none>',
  });
}

function handleDidAttachWebview(attached: WebContents): void {
  // Routed by session identity, not URL: the session is known the instant a
  // webview attaches, while its URL can still be empty that early.
  const extensionId = extensionIdForSession(attached.session);
  if (extensionId) {
    // An extension may render; it may not spawn windows. A new window sits
    // outside the tab the user opened and outside the sandbox they agreed to.
    attached.setWindowOpenHandler(() => ({ action: 'deny' }));
    attached.on('will-navigate', (event, url) => {
      if (isAllowedExtensionNavigation(url, extensionId)) return;
      event.preventDefault();
      log.warn('Blocked extension navigation away from its bundle', { extensionId });
      // And the App's author hears it, pointed at gugu.openBrowserTab (统筹 06:52) — not a silence.
      void import('@main/core/extensions/extension-bridge').then(({ reportBlockedNavigation }) => reportBlockedNavigation(attached.id, url));
    });
    return;
  }
  // 准入那一步只放行扩展的分区;走到这里的不该存在 —— 关掉,❌ 留一个没人收紧过的客体。
  attached.close();
  log.warn('Closed a webview outside every known surface');
}
