import {
  pushAppStateToAllSurfaces,
  pushContextToAllSurfaces,
  setExtensionBridgeHost,
  type ExtensionBridgeHost,
} from '@main/core/extensions/extension-bridge';
import {
  EXTENSION_HOST_ACTION_METHOD,
  INSTALLED_NOT_SHOWN_NOTE,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
  type ExtensionHostAction,
  type ExtensionHostActionCommand,
  type ExtensionHostActionOrigin,
} from '@shared/extensions/host-actions';
/**
 * Carries an allowed action from the bridge to the renderer that draws it.
 *
 * Rides the existing main→renderer command channel rather than one of its own:
 * two push mechanisms drift, and the newer one is the one nobody remembers to
 * maintain. That channel already carries a **result** back, which is why this
 * awaits — an extension that asked to rename its tab and got silence would have
 * no way to tell "done" from "went nowhere". Refs #2374.
 *
 * The channel is **injected by the host**, not imported. This file is bundled
 * into dist-electron/taskpage/emdash-main-bridge.cjs; `electron/ipc-bridge` is
 * bundled into main.js. Importing it from here (`../../../../ipc-bridge`, as
 * this did) does not reach the host's copy — esbuild pulls a SECOND copy into
 * the sessionpage bundle, whose module-level `_window` nothing ever assigns
 * because `setMainWindow` is only called on the host's copy (and is tree-shaken
 * out of this one for having no caller). Every host action therefore rejected
 * with「Renderer not ready」from the day it shipped: setTabTitle, setTabBadge,
 * openBrowserTab, reportError, compose — all five, always. It stayed
 * hidden because the examples swallow that rejection with `.catch(() => {})`,
 * and because the unit test mocked `'../../../../ipc-bridge'` — mocking away
 * the exact boundary that was broken, so the judge stayed green through the
 * whole outage. ❌ 别把宿主模块相对 import 进会话页这一侧。
 */

/** What this relay needs from the host process's own renderer channel. */
export type ExtensionHostWindowChannel = {
  invokeRendererExtensions: (
    method: string,
    params: unknown,
    embedderId: number
  ) => Promise<unknown>;
  /** `raise`: brought in front of the person first — only when they are at this computer (D-31, consent-in-session). */
  requestExtensionInstallConsent: (
    request: ExtensionInstallConsentRequest,
    options?: { raise?: boolean }
  ) => Promise<ExtensionInstallConsentResult>;
  /** D-31 That ask was answered on another surface, or ran out: its sheet in this window goes. */
  closeExtensionInstallConsent: (requestId: string) => Promise<void>;
  /** 已装的集合变了,让渲染端重新登记 tab。装完不喊,新 tab 要整页刷新才出现。 */
  notifyInstalledExtensionsChanged: () => Promise<void>;
  /** Members' faces by id (`lib/memberFaces.ts`). */
  drawMemberFaces: (people: readonly { id: string; avatar: string | null }[]) => Promise<Record<string, string>>;
  /** #7158 The project the window's task list has another computer's session under, or null (`remoteHostsStore.listedProject`). */
  listedSession: (sessionId: string) => Promise<string | null>;
  /** An action no page asked for (a link's or a banner's click), done by the window that shows chats and Apps. */
  act: (command: ExtensionHostActionCommand) => Promise<void>;
  isHostWindowFullScreen: () => boolean;
  onHostWindowFullScreenChange: (listener: () => void) => () => void;
  /**
   * Whether gugu's window is in the foreground, and a subscription for when that
   * moves. Read from the window like `fullscreen`, ❌ 不由渲染层上报 —— 一个真值
   * 两个来源,后写的那个赢。
   */
  isHostWindowFocused: () => boolean;
  onHostWindowFocusChange: (listener: () => void) => () => void;
  /**
   * The language and the light/dark tone gugu is drawn in, and a subscription for when either moves. Read from the
   * host's own records (its locale store, its window tone), ❌ 不由会话页的渲染层上报:those records exist from the
   * first moment of a boot and on a server with no window, while a renderer's report arrives only once it has drawn —
   * and the default this relay used to hold until then was made up ('en' / 'dark').
   */
  hostLocale: () => string;
  hostTone: () => 'light' | 'dark';
  onHostPresentationChange: (listener: () => void) => () => void;
};

let hostWindow: ExtensionHostWindowChannel | null = null;
let unsubscribeFullScreen: (() => void) | null = null;
let unsubscribeFocus: (() => void) | null = null;
let unsubscribePresentation: (() => void) | null = null;

/**
 * The host hands over its live renderer channel; `null` takes it back.
 *
 * Called as soon as the host loads this module — not after boot — so a boot
 * that fails leaves the channel plainly absent rather than half-wired. The
 * previous subscription is dropped on every call, so re-injecting does not
 * leave an old channel still broadcasting.
 */
export function setExtensionHostWindowChannel(
  channel: ExtensionHostWindowChannel | null
): void {
  unsubscribeFullScreen?.();
  unsubscribeFullScreen = null;
  unsubscribeFocus?.();
  unsubscribeFocus = null;
  unsubscribePresentation?.();
  unsubscribePresentation = null;
  hostWindow = channel;
  if (!channel) return;
  // Fullscreen is read from the window, so nothing else would notice it moved.
  unsubscribeFullScreen = channel.onHostWindowFullScreenChange(() => {
    pushContextToAllSurfaces();
  });
  // Focus lives in the app state, not the context — pushing the context here
  // instead would wake every surface for a fact that is not in the payload.
  unsubscribeFocus = channel.onHostWindowFocusChange(() => {
    pushAppStateToAllSurfaces();
  });
  // Open surfaces are told rather than left to ask again: an extension that read its context once would otherwise
  // keep rendering in the previous language.
  unsubscribePresentation = channel.onHostPresentationChange(() => {
    pushContextToAllSurfaces();
  });
}

function requireHostWindow(): ExtensionHostWindowChannel {
  if (!hostWindow) {
    // Loud on purpose: a missing channel breaks every host-facing verb at once,
    // and a plausible-looking default (fullscreen: false) would hide that.
    throw new Error(
      'Extension host window channel was never injected — the host must call setExtensionHostWindowChannel'
    );
  }
  return hostWindow;
}

async function deliver(
  origin: ExtensionHostActionOrigin & { embedderId: number | null },
  action: ExtensionHostAction
): Promise<void> {
  if (origin.embedderId === null) {
    throw new Error('This surface is not embedded in a renderer that can act on its behalf');
  }
  const command: ExtensionHostActionCommand = {
    origin: { extensionId: origin.extensionId, sessionId: origin.sessionId, tabId: origin.tabId },
    action,
  };
  await requireHostWindow().invokeRendererExtensions(
    EXTENSION_HOST_ACTION_METHOD,
    command,
    origin.embedderId
  );
}

export const extensionBridgeRelayHost: ExtensionBridgeHost = {
  deliver,
  presentation: () => ({
    locale: requireHostWindow().hostLocale(),
    themeMode: requireHostWindow().hostTone(),
    fullscreen: requireHostWindow().isHostWindowFullScreen(),
    windowFocused: requireHostWindow().isHostWindowFocused(),
  }),
};

export function requestExtensionInstallConsent(
  request: ExtensionInstallConsentRequest,
  options?: { raise?: boolean }
): Promise<ExtensionInstallConsentResult> {
  return Promise.resolve().then(() => requireHostWindow().requestExtensionInstallConsent(request, options));
}

export function closeExtensionInstallConsent(requestId: string): Promise<void> {
  return Promise.resolve().then(() => requireHostWindow().closeExtensionInstallConsent(requestId));
}

/**
 * 告诉渲染端「已装的集合变了」。
 *
 * 登记 tab 只发生在会话页挂载 / 从设置里装 / open_in_tab 撞到未知 tab 这三处 —— agent 自己装完
 * 一处都不经过,所以必须在这里补一声,否则新 tab 要整页刷新才出现(owner 实测 #4135)。
 */
export function notifyInstalledExtensionsChanged(): Promise<void> {
  return Promise.resolve().then(() => requireHostWindow().notifyInstalledExtensionsChanged());
}

/** What a link's or a banner's click opens in the window: the App in a chat's panel or on its own page, a chat's file. */
export function actInWindow(action: ExtensionHostAction): Promise<void> {
  return Promise.resolve().then(() => requireHostWindow().act({ origin: null, action }));
}

/** Members' faces, asked of the window (`lib/memberFaces.ts`). */
export function drawMemberFaces(people: readonly { id: string; avatar: string | null }[]): Promise<Record<string, string>> {
  return Promise.resolve().then(() => requireHostWindow().drawMemberFaces(people));
}

/** The project the task list has another computer's session under, or null, asked of the window (`gugu.showSession`). */
export function listedSessionProject(sessionId: string): Promise<string | null> {
  return Promise.resolve().then(() => requireHostWindow().listedSession(sessionId));
}

/** How long an install waits for the window to take the new set in before answering anyway (摩擦单 F52). */
export const INSTALLED_CHANGED_WAIT_MS = 1500;

/**
 * The install has happened; this tells the window, and says whether it took it in: `shown` when it confirmed within
 * a moment, `pending` when it has not answered yet (the notice keeps going), `failed` when it could not be told.
 * Never throws. L5 S2 (F52): a stuck window's `IPC timeout: extensions:cmd/extensions.installedChanged` came back as
 * the install failing, while the App was installed — a side effect that happened must never answer as an error.
 */
export function announceInstalledChanged(
  notify: () => Promise<void> = notifyInstalledExtensionsChanged,
): Promise<'shown' | 'pending' | 'failed'> {
  const told = notify().then(
    () => 'shown' as const,
    () => 'failed' as const,
  );
  const waited = new Promise<'pending'>((resolve) => {
    setTimeout(() => resolve('pending'), INSTALLED_CHANGED_WAIT_MS).unref?.();
  });
  return Promise.race([told, waited]);
}

/**
 * What an install's answer adds when the window did not take it in: the sentence first in `next`, and the mark the MCP
 * host keeps it by when it rewrites `next` for a group App.
 */
export function windowNoteOf(shown: 'shown' | 'pending' | 'failed'): { window: 'not-confirmed'; note: string } | null {
  return shown === 'shown' ? null : { window: 'not-confirmed', note: INSTALLED_NOT_SHOWN_NOTE };
}

export function installExtensionBridgeRelay(): void {
  setExtensionBridgeHost(extensionBridgeRelayHost);
}
