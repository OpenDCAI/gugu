import { composeChatDraft } from '@/lib/composeDraft';
import { followLink, openLinkTarget } from '@/lib/guguLinks';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { rpc } from '@renderer/lib/ipc';
import { desktopIpc } from '@/platform/desktopIpc';
import { EXTENSION_BRIDGE_CHANNEL, type ExtensionBridgeResponse } from '@shared/extensions/bridge-protocol';
import type { AppModalHostAction } from '@shared/extensions/app-modal';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';

import { runInAction } from 'mobx';
import type { RendererRpcHandlers } from '@/rpc-renderer/rendererRpc';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';
import {
  EXTENSION_HOST_ACTION_METHOD,
  EXTENSION_INSTALL_CONSENT_CLOSE_METHOD,
  EXTENSION_INSTALL_CONSENT_METHOD,
  EXTENSION_INSTALLED_CHANGED_METHOD,
  EXTENSION_LISTED_SESSION_METHOD,
  EXTENSION_MEMBER_FACES_METHOD,
  EXTENSION_PICK_DISPATCH_TARGET_METHOD,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
  type ExtensionHostAction,
  type ExtensionHostActionResult,
  type ExtensionHostActionCommand,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
} from '@shared/extensions/host-actions';
import {
  APP_FORUM_CONSENT_EVENT,
  APP_OPEN_WITH_EVENT,
} from '@shared/extensions/app-runtime-protocol';
import type { DispatchAsk } from '@shared/extensions/app-dispatch-core';
import { openApp } from './app-dock';
import { installedExtensionsStore } from './installed-extensions-store';
import { safeParseExtensionManifest } from '@shared/extensions/manifest';
import { extensionSurfaceStore } from './extension-surface-store';
import { peekStore } from './peek-store';
import { screenLayout } from '@renderer/app/screen-layout';
import { focusScreenBlock } from '@renderer/app/screen-layout-actions';
import { appState } from '@renderer/lib/stores/app-state';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { askInShell, closeInShell, installConsentPrompt } from './install-consent';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { closeAppModal, focusAppModalClose, showAppModal } from '@/components/appModal/appModal';
import { groupPageSlot } from '@renderer/features/chats/chat-tabs/chat-panel-item';

/**
 * Performs the actions main has already decided an extension is allowed to take.
 *
 * Nothing here re-checks permission, and nothing here can be reached without
 * having passed main first: identity comes from the surface's session, which
 * only main can read. The renderer's job is the half main cannot do — it owns
 * the tab strip and the conversation. Refs #2374.
 *
 * Every handler throws on failure rather than returning quietly. The bridge
 * turns a throw into a failed call the extension can see, and 「做没做成」是扩展
 * 唯一能据以重试或提示用户的信息。
 */

/**
 * The task's view, found by scanning the mounted projects.
 *
 * Scanned rather than addressed because an action carries the task it came
 * from, not the project: the surface never knew the project id, and inventing a
 * way to tell it one would hand extensions a fact they have no use for.
 */
function findSessionView(sessionId: string): WorkspaceViewModel | undefined {
  for (const project of getProjectManagerStore().projects.values()) {
    const store = project.mountedProject?.sessionManager.sessions.get(sessionId);
    if (store?.viewModel) return store.viewModel;
  }
  return undefined;
}

function requireSessionView(sessionId: string | null): WorkspaceViewModel {
  const view = sessionId === null ? null : findSessionView(sessionId);
  if (!view) throw new Error('This session is no longer open');
  return view;
}

/** The block of the screen a session is drawn in, while that screen is what the person sees; null otherwise. */
function blockOnScreen(sessionId: string): string | null {
  if (!isEmbedVisible() || appState.navigation.currentViewId !== 'session') return null;
  return screenLayout.blockOfSession(sessionId) ?? null;
}

export function applyExtensionHostAction(command: ExtensionHostActionCommand): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  const { origin, action } = command;
  // A link's or a banner's click has no page behind it: only what names its own target is done for it.
  if (!origin) return runInAction(() => openForClick(action));
  return runInAction(() => perform(origin.sessionId, origin.tabId, action));
}

function openForClick(action: ExtensionHostAction, fromTab?: string): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  switch (action.kind) {
    case 'openApp':
      if (action.chatId) return openLinkTarget({ kind: 'app', extensionId: action.extensionId, tab: action.tab ?? installedExtensionsStore.mainTabOf(action.extensionId)?.kind.slice(action.extensionId.length + 1) ?? '', path: '', query: {}, place: { chat: action.chatId } });
      { const opened = openApp(action.extensionId, action.tab); revealSessionpage(); return opened; }
    case 'openChatFile':
      if (action.onlyIfOpen) return import('@renderer/features/chats/chat-tabs/chat-layouts').then(({ panelTabsOf, showChatTab }) => {
        const tabs = panelTabsOf(action.chatId);
        if (!tabs.some((entry) => entry.shown && !entry.inWindow && groupPageSlot(action.chatId, entry.tabId) === fromTab)) return;
        const tab = tabs.find((entry) => !entry.inWindow && entry.item.itemId === action.itemId && entry.item.kind === action.onlyIfOpen);
        if (!tab) return;
        showChatTab(action.chatId, tab.tabId);
        // The body is already there. The original metadata validation starts after presenting it.
        return new Promise<{ chat: string }>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ chat: action.chatId }))));
      });
      return openLinkTarget({ kind: 'file', itemId: action.itemId });
    case 'openLinkTarget':
      return openLinkTarget(action.target);
    case 'notGivenAt': {
      // The App's page in 「App」 is where a chat is added, one at a time (`changeAppPlaces`).
      const app = installedExtensionsStore.manifests.find((manifest) => manifest.id === action.extensionId)?.name ?? action.extensionId;
      toast({
        title: translateSessionMessage('extensions.notGivenAt', { app, chat: action.chat.name }),
        tier: 'warning',
        duration: 15_000,
        action: { label: translateSessionMessage('extensions.notGivenAtAction'), onClick: () => void followLink({ kind: 'app-detail', extensionId: action.extensionId }) },
      });
      return undefined;
    }
    default:
      throw new Error(`${action.kind} is a page's: no page asked for it`);
  }
}

function perform(sessionId: string | null, tabId: string, action: ExtensionHostAction): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  // What a page says about itself: a task's tab or a group's slot (sessionId null), kept by page (extensionSurfaceStore.say).
  switch (action.kind) {
    case 'openAppModal': {
      let guest: BrowserWebviewElement | null = null;
      let previous = document.activeElement;
      while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
      const control = async (action: AppModalHostAction) => {
        const response = await desktopIpc()!.invoke(EXTENSION_BRIDGE_CHANNEL, { method: 'modalHost', args: action }) as ExtensionBridgeResponse;
        if (!response.ok) throw new Error(response.message);
      };
      const dismiss = (error?: string) => control({ type: 'dismiss', id: action.page.id, ...(error ? { error } : {}) });
      const fail = (error: unknown) => dismiss(error instanceof Error ? error.message : String(error));
      const focus = async (edge: 'first' | 'last') => {
        guest?.focus();
        await control({ type: 'focus', id: action.page.id, edge });
      };
      showAppModal({
        id: action.page.id, title: action.page.title, appName: action.page.appName, size: action.page.size,
        url: action.page.entryUrl, partition: action.page.partition,
        opener: previous instanceof HTMLElement ? previous : document.body,
        focus, dismiss,
        attach(element) {
          guest = element as BrowserWebviewElement;
          let boundId: number | null = null;
          const report = () => {
            if (boundId !== null) void rpc.extensions.reportLayout({ webContentsId: boundId, visible: true, width: element.clientWidth, height: element.clientHeight }).catch(fail);
          };
          const observer = new ResizeObserver(report);
          observer.observe(element);
          const ready = () => {
            const webContentsId = (element as BrowserWebviewElement).getWebContentsId();
            void control({ type: 'bind', id: action.page.id, webContentsId }).then(() => {
              if (guest !== element) return;
              boundId = webContentsId; report(); return focus('first');
            }).catch((error: unknown) => { if (guest === element) void fail(error); });
          };
          const gone = () => void fail(new Error('The App modal content process exited'));
          const failed = (event: Event) => {
            const failure = event as Event & { errorCode?: number; errorDescription?: string };
            if (failure.errorCode !== -3) void fail(new Error(failure.errorDescription ?? 'The App modal page did not load'));
          };
          element.addEventListener('dom-ready', ready);
          element.addEventListener('render-process-gone', gone);
          element.addEventListener('did-fail-load', failed);
          return () => {
            observer.disconnect();
            element.removeEventListener('dom-ready', ready);
            element.removeEventListener('render-process-gone', gone);
            element.removeEventListener('did-fail-load', failed);
            guest = null;
          };
        },
      });
      return;
    }
    case 'closeAppModal':
      closeAppModal(action.id);
      return;
    case 'focusAppModalClose':
      focusAppModalClose(action.id);
      return;
    case 'setTabTitle':
      extensionSurfaceStore.say(sessionId, tabId, { title: action.title });
      return;
    case 'setTabBadge':
      extensionSurfaceStore.say(sessionId, tabId, { badge: action.badge });
      return;
    case 'reportError':
      extensionSurfaceStore.say(sessionId, tabId, { error: action.message });
      return;
    case 'newDocument':
      extensionSurfaceStore.say(sessionId, tabId, { title: null, badge: null, error: null });
      return;
    case 'openBrowserTab': {
      const view = requireSessionView(sessionId);
      view.showPage(action.url, { preview: false, reload: false });
      view.setFocusedRegion('main');
      return;
    }
    case 'compose': {
      // A chat's: the chat shell takes it (MainLayout: its draft, the chat brought up), as the phone's page gives it.
      if ('detail' in action) {
        // Capture flushes pending typing before the shell appends during bubbling.
        composeChatDraft(action.detail);
        return;
      }
      // A session's: main brought it on screen; its composer takes the text once its conversation is open there.
      const target = action.sessionId;
      return import('./compose-in-session').then(({ composeWhenOpen }) => composeWhenOpen(() => findSessionView(target), action.text));
    }
    // The chat shell takes them (MainLayout: another chat comes up first), as the phone's page gives them.
    case 'showMessage':
      return openLinkTarget({ kind: 'chat', chatId: action.detail.chatId, messageId: action.detail.messageId });
    case 'openWith':
      if (action.detail.background) return import('@renderer/features/chats/chat-tabs/chat-layouts').then(({ updateFileNames }) => {
        const detail = action.detail;
        updateFileNames([{ id: detail.itemId, filename: detail.name, content_type: detail.file.contentType }], installedExtensionsStore.manifests);
      });
      window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail: action.detail }));
      return;
    // The shell draws the forum's consent sheet (ForumConsent), as the phone's page gives it.
    case 'forumConsent':
      window.dispatchEvent(new CustomEvent(APP_FORUM_CONSENT_EVENT, { detail: action.detail }));
      return;
    // Beside the page that asked, in the slot it is drawn in: that slot draws it (AppPeekSlot). A session already in a
    // block on screen is not drawn twice: that block is looked at instead (one session, one place — ScreenArea).
    case 'peek': {
      const block = action.target.kind === 'session' ? blockOnScreen(action.target.sessionId) : null;
      if (block) return focusScreenBlock(block);
      peekStore.open(sessionId, tabId, action.target);
      return;
    }
    case 'openApp':
    case 'openChatFile':
    case 'openLinkTarget':
      return openForClick(action, tabId);
  }
}

export const extensionHostActionHandlers: RendererRpcHandlers = {
  [EXTENSION_HOST_ACTION_METHOD]: async (params: unknown) => {
    const opened = await applyExtensionHostAction(params as ExtensionHostActionCommand);
    return { ok: true, opened };
  },
  /**
   * 已装的集合变了 —— 重新登记 tab,新装的扩展这才在 tab 栏里出现。
   *
   * 动态 import 与 open-file-in-file-editor 那处同因:把 register-extension-tabs 的模块图静态拉进
   * 这份 handler,等于把它塞进每一条走 extensions 通道的路径。❌ 别改成顶层 import。
   */
  [EXTENSION_INSTALLED_CHANGED_METHOD]: async (): Promise<{ ok: true }> => {
    const { registerInstalledExtensionTabs } = await import('./register-extension-tabs');
    await registerInstalledExtensionTabs();
    // What the market has to say is about what is installed: an App updated by itself (auto-update-apps.ts) has no update now.
    const { installedExtensionsStore } = await import('./installed-extensions-store');
    void installedExtensionsStore.checkUpdates();
    return { ok: true };
  },
  /** Members' faces (`lib/memberFaces.ts`). Imported when asked, as above. */
  [EXTENSION_MEMBER_FACES_METHOD]: async (params: unknown): Promise<Record<string, string>> => {
    const people = (params as { people?: unknown } | null)?.people;
    if (!Array.isArray(people)) throw new Error('Invalid member faces request');
    const { memberFaces } = await import('@/lib/memberFaces');
    return memberFaces(people as { id: string; avatar: string | null }[]);
  },
  /**
   * #7158 `gugu.showSession` for a session not on this computer: the project the task list has it under, or null when
   * the list has none. Only an answer — main brings it up the one way a banner's click does. Imported when asked, as above.
   */
  [EXTENSION_LISTED_SESSION_METHOD]: async (params: unknown): Promise<string | null> => {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string') throw new Error('Invalid listed session request');
    const { remoteHostsStore } = await import('@renderer/features/remote-hosts/remote-hosts-store');
    return remoteHostsStore.listedProject(sessionId);
  },
  /** `gugu.dispatch` naming no target: the person picks one in the shell's sheet (DispatchSheet). */
  [EXTENSION_PICK_DISPATCH_TARGET_METHOD]: async (params: unknown) => {
    const { pickDispatchTarget } = await import('@/components/chat/dispatchAsk');
    return pickDispatchTarget(params as DispatchAsk);
  },
  [EXTENSION_INSTALL_CONSENT_METHOD]: (params: unknown): Promise<ExtensionInstallConsentResult> => {
    if (!params || typeof params !== 'object') throw new Error('Invalid extension consent request');
    const request = params as ExtensionInstallConsentRequest;
    if (typeof request.sourceDir !== 'string' || typeof request.manifestDigest !== 'string') {
      throw new Error('Invalid extension consent request');
    }
    const parsed = safeParseExtensionManifest(request.manifest);
    if (!parsed.ok) throw new Error('Invalid extension consent manifest');

    const requestId = request.requestId ?? `${request.manifestDigest}:${Date.now()}`;
    // The same words and the same sheet as the phone's own installs (install-consent.ts).
    const prompt = installConsentPrompt(request, parsed.manifest);
    const inShell = askInShell(prompt, requestId, INSTALL_CONSENT_HUMAN_WINDOW_MS, request.given, request.requester, request.machine);
    // The shell (MainLayout) draws it on the desktop and the phone alike; there is no second way (D-31: the 「切到任务页再弹」
    // fallback is gone — it switched the person's view, the one thing F6 asked never to do).
    if (!inShell) throw new Error('No consent sheet in this window to ask the person with');
    return inShell;
  },
  /** D-31 The ask was answered on another surface, or ran out: this window's sheet for it goes. */
  [EXTENSION_INSTALL_CONSENT_CLOSE_METHOD]: (params: unknown): { ok: true } => {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') throw new Error('Invalid extension consent close');
    closeInShell(requestId);
    return { ok: true };
  },
};
