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
  EXTENSION_PICK_COMPOSE_TARGET_METHOD,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
  type ExtensionHostAction,
  type ExtensionHostActionCommand,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
} from '@shared/extensions/host-actions';
import {
  APP_COMPOSE_EVENT,
  APP_FORUM_CONSENT_EVENT,
  APP_OPEN_IN_CHAT_EVENT,
  APP_OPEN_WITH_EVENT,
  APP_SHOW_MESSAGE_EVENT,
  GROUP_FILE_OPEN_EVENT,
  type AppComposeDetail,
  type AppOpenInChatDetail,
} from '@shared/extensions/app-runtime-protocol';
import type { ComposePickAsk } from '@shared/extensions/app-send-core';
import { openApp } from './app-dock';
import { safeParseExtensionManifest } from '@shared/extensions/manifest';
import { extensionSurfaceStore } from './extension-surface-store';
import { peekStore } from './peek-store';
import { screenLayout } from '@renderer/app/screen-layout';
import { focusScreenBlock } from '@renderer/app/screen-layout-actions';
import { appState } from '@renderer/lib/stores/app-state';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { askInShell, closeInShell, installConsentPrompt } from './install-consent';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';

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

export function applyExtensionHostAction(command: ExtensionHostActionCommand): void | Promise<void> {
  const { origin, action } = command;
  // A link's or a banner's click has no page behind it: only what names its own target is done for it.
  if (!origin) return runInAction(() => openForClick(action));
  return runInAction(() => perform(origin.sessionId, origin.tabId, action));
}

function openForClick(action: ExtensionHostAction): void {
  switch (action.kind) {
    case 'openApp':
      // A chat named: the chat shell brings it up and its panel opens the App. None: where it is (#7052), as its rail icon.
      if (action.chatId) {
        window.dispatchEvent(new CustomEvent<AppOpenInChatDetail>(APP_OPEN_IN_CHAT_EVENT, { detail: { chatId: action.chatId, extensionId: action.extensionId } }));
      } else {
        openApp(action.extensionId);
        revealSessionpage();
      }
      return;
    case 'openChatFile':
      // As a link to the file opens it: its chat comes up, its panel opens the file.
      window.dispatchEvent(new CustomEvent(GROUP_FILE_OPEN_EVENT, { detail: { chatId: action.chatId, itemId: action.itemId }, cancelable: true }));
      return;
    default:
      throw new Error(`${action.kind} is a page's: no page asked for it`);
  }
}

function perform(sessionId: string | null, tabId: string, action: ExtensionHostAction): void | Promise<void> {
  // What a page says about itself: a task's tab or a group's slot (sessionId null), kept by page (extensionSurfaceStore.say).
  switch (action.kind) {
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
        window.dispatchEvent(new CustomEvent<AppComposeDetail>(APP_COMPOSE_EVENT, { detail: action.detail }));
        return;
      }
      // A session's: main brought it on screen; its composer takes the text once its conversation is open there.
      const target = action.sessionId;
      return import('./compose-in-session').then(({ composeWhenOpen }) => composeWhenOpen(() => findSessionView(target), action.text));
    }
    // The chat shell takes them (MainLayout: another chat comes up first), as the phone's page gives them.
    case 'showMessage':
      window.dispatchEvent(new CustomEvent(APP_SHOW_MESSAGE_EVENT, { detail: action.detail }));
      return;
    case 'openWith':
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
      return openForClick(action);
  }
}

export const extensionHostActionHandlers: RendererRpcHandlers = {
  [EXTENSION_HOST_ACTION_METHOD]: async (params: unknown) => {
    await applyExtensionHostAction(params as ExtensionHostActionCommand);
    return { ok: true };
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
  /** `gugu.compose(text)` naming no place: the person picks one in the shell's sheet (ComposeTargetPicker). */
  [EXTENSION_PICK_COMPOSE_TARGET_METHOD]: async (params: unknown) => {
    const { pickComposeTarget } = await import('@/components/chat/ComposeTargetPicker');
    return pickComposeTarget(params as ComposePickAsk);
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
    const inShell = askInShell(prompt, requestId, INSTALL_CONSENT_HUMAN_WINDOW_MS, request.places, request.requester, request.machine);
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
