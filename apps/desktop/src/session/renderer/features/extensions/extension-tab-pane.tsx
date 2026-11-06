import { ExtensionGuestBinding, type ExtensionGuestTarget } from './extension-guest-binding';
import { projectWorkspace, sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { useTaskConversation } from '@/lib/taskConversation';
import { useCallback, useMemo, useContext, useEffect, useRef, useState } from 'react';
import { TabLayerShownContext } from '@renderer/features/tabs/retained-tab-content';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { extensionSurfaceStore } from './extension-surface-store';
import { ExtensionTabToolbar } from './extension-tab-toolbar';
import { bindAppPageZoom } from '@/components/preview/file-content-zoom';

/**
 * Renders one extension's surface: a <webview> on the extension's own
 * partition, loading its entry over gugu-ext://.
 *
 * Mounting waits for activation. The main process refuses to attach a webview
 * whose session it has not hardened, so mounting first would show an empty
 * frame that reads as a broken extension rather than an unmet precondition.
 * Refs #2374.
 */

interface ExtensionSurface {
  partition: string;
  entryUrl: string;
}

/**
 * Why a surface is not showing. Activation failures without a message of their
 * own are worded at render time, so the effect that reports them does not have
 * to depend on the translator.
 */
type SurfaceFailure = { kind: 'activation' } | { kind: 'reported'; message: string };

export function ExtensionTabPane({
  extensionId,
  tabKind,
  sessionId,
  tabId,
  viewState,
  navigation,
  filePath,
  projectId,
  chatId,
  resourceChat,
  itemId,
}: {
  extensionId: string;
  /** `<extensionId>.<tabName>` — which contribution this surface is drawing. */
  tabKind: string;
  /** Null: the pane is in no session yet (the draft panel). */
  sessionId: string | null;
  tabId: string;
  viewState?: Record<string, unknown>;
  navigation?: { canBack: boolean; canForward: boolean; backToConversation?: boolean };
  /**
   * The file this tab was opened for, when it was opened because the extension
   * claimed that file type. Passed to the bind call so the surface can read it
   * from `getContext()` — the host decides which file a claimed tab is showing,
   * never the surface.
   */
  filePath?: string;
  /** G1 With `filePath` and no session: the project whose folder the file is in (a page opened beside another). */
  projectId?: string;
  /** Drawn for a chat (a chat's tab in a window of its own), and the chat file it was opened for. */
  chatId?: string;
  resourceChat?: string;
  itemId?: string;
}) {
  const { translate } = useSessionMessages();
  // Where it is (`AppWhere`): a chat's tab is in that chat, a session's in the person's private chat with its agent.
  const taskConversation = useTaskConversation(chatId ? null : sessionId);
  // Read when it binds (a ref: the chat list coming in later must not re-attach the webview).
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = chatId ?? taskConversation;
  const resourceChatRef = useRef(resourceChat);
  resourceChatRef.current = resourceChat;
  const workspace = sessionId ? sessionWorkspace(sessionId) : projectId && filePath ? projectWorkspace(projectId) : null;
  const [surface, setSurface] = useState<ExtensionSurface | null>(null);
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Not looked at while its retained session page is hidden (@@@retained-session-pages).
  const pageShown = useContext(PageShownContext);
  const layerShown = useContext(TabLayerShownContext);
  const shown = pageShown && layerShown;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const reportLayoutRef = useRef<(() => void) | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const zoomTeardownRef = useRef<(() => void) | null>(null);
  /** Stops the size/visibility reports when the surface goes away. */
  const layoutTeardownRef = useRef<(() => void) | null>(null);

  // Activation depends on the extension, not on the current language: keeping
  // `translate` out of the dependencies is what stops a fresh translator
  // identity each render from tearing the surface down and asking again.
  useEffect(() => {
    let disposed = false;
    setSurface(null);
    setFailure(null);
    void rpc.extensions
      // The tab kind, not just the extension: a contribution may bring its own
      // page, and without saying which tab this is every one of them would draw
      // the manifest's entry.
      .activate({ extensionId, tabKind })
      .then((result) => {
        if (disposed) return;
        if (result.success && result.data) setSurface(result.data);
        else
          setFailure(
            result.error ? { kind: 'reported', message: result.error } : { kind: 'activation' }
          );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        log.warn('Extension activation failed:', error);
        setFailure({ kind: 'reported', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [extensionId, tabKind]);

  useEffect(
    () => () => {
      extensionSurfaceStore.setWebContentsId(sessionId, tabId, null);
    },
    [sessionId, tabId]
  );

  useEffect(
    () => () => {
      layoutTeardownRef.current?.();
      layoutTeardownRef.current = null;
    },
    []
  );

  /**
   * Reports this surface's own box, so an extension can lay itself out for the
   * space it actually has rather than guessing from `window.innerWidth`.
   *
   * Measured from the container, not the guest: the guest's own view of its size
   * is what we are trying to tell it, and asking it would be circular. Reports
   * are deduplicated in main, so a resize drag does not become an event stream.
   */
  const startLayoutReports = useCallback((webContentsId: number) => {
    const container = containerRef.current;
    if (!container) return;
    const report = () => {
      const box = container.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      void rpc.extensions
        .reportLayout({
          webContentsId,
          // Collapsed to nothing, or the window is not being shown at all: either
          // way the user is not looking at this surface.
          visible: shownRef.current && document.visibilityState === 'visible' && width > 0 && height > 0,
          width,
          height,
        })
        .catch((error: unknown) => {
          log.warn('Failed to report extension surface layout:', error);
        });
    };
    reportLayoutRef.current = report;
    report();
    const observer = new ResizeObserver(report);
    observer.observe(container);
    document.addEventListener('visibilitychange', report);
    layoutTeardownRef.current = () => {
      reportLayoutRef.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', report);
    };
  }, []);

  // Same box when its page is hidden or shown again, so the observer stays quiet: report the change.
  useEffect(() => {
    reportLayoutRef.current?.();
  }, [shown]);

  const guestBinding = useMemo(() => new ExtensionGuestBinding({
    bind: (webContentsId, target) => rpc.extensions.bindSurface({ webContentsId, extensionId, tabKind, ...target }),
    retarget: (webContentsId, target) => rpc.extensions.retargetSurface({ webContentsId, ...target }),
  }), [extensionId, tabKind]);
  const targetRef = useRef<ExtensionGuestTarget>({ tabId, workspace, conversation: conversationRef.current });
  targetRef.current = { workspace, conversation: conversationRef.current, resourceChat: resourceChatRef.current, tabId, itemId, filePath, viewState, navigation };
  // @@@one-guest-many-tabs - Tabs of one kind share this pane and its webview, so another tab is a retarget of the live
  // guest. Nothing the webview's ref depends on may change with the tab: a new ref forgets the guest, and dom-ready, the
  // only thing that hands it back, does not fire again on a page already loaded.
  const slotRef = useRef({ sessionId, tabId });
  slotRef.current = { sessionId, tabId };
  const aim = useCallback(async () => {
    const result = await guestBinding.aim(targetRef.current);
    if (result && !result.success) log.warn('Extension surface binding refused:', result.error);
    if (result?.success) extensionSurfaceStore.setWebContentsId(slotRef.current.sessionId, slotRef.current.tabId, result.webContentsId);
    return result;
  }, [guestBinding]);
  useEffect(() => { void aim().catch((error: unknown) => log.warn('Extension surface binding failed:', error)); }, [aim, sessionId, tabId, filePath, itemId, viewState, navigation?.canBack, navigation?.canForward, navigation?.backToConversation]);

  const attachWebview = useCallback(
    (element: BrowserWebviewElement | null) => {
      webviewRef.current = element;
      layoutTeardownRef.current?.();
      layoutTeardownRef.current = null;
      zoomTeardownRef.current?.();
      zoomTeardownRef.current = null;
      extensionSurfaceStore.setWebContentsId(slotRef.current.sessionId, slotRef.current.tabId, null);
      if (!element) { guestBinding.reset(); return; }
      // The page is zoomed by the host, remembered per App (zoom B).
      if (element.parentElement) zoomTeardownRef.current = bindAppPageZoom(element.parentElement, element, extensionId);
      element.addEventListener('dom-ready', () => {
        // Bind before the surface can call anything: until main knows which task
        // this webContents is showing, every bridge call is refused. Done on
        // dom-ready because that is the first moment the guest exists and its
        // webContents id can be read.
        //
        // A surface with no working copy still binds (the draft panel, before a
        // task exists): it legitimately owns its own tab and may want its title,
        // theme and language. Only the file verbs fail there, and they fail
        // loudly rather than resolving against some other directory.
        guestBinding.ready(element.getWebContentsId());
        void aim().then((result) => {
          if (result?.success) startLayoutReports(element.getWebContentsId());
        });
      });
    },
    [guestBinding, aim, startLayoutReports, extensionId]
  );

  const failureText =
    failure?.kind === 'reported' ? failure.message
    : failure ? translate('extensions.activationFailed')
    : null;

  return (
    <div ref={containerRef} className="h-full w-full">
      {failureText ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-foreground-muted">
          {failureText}
        </div>
      ) : !surface ? (
        <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
          {translate('extensions.preparing')}
        </div>
      ) : (
        <div className="flex h-full w-full flex-col">
          <ExtensionTabToolbar tabKind={tabKind} sessionId={sessionId} tabId={tabId} />
          <webview
            key={`${extensionId}:${surface.partition}`}
            ref={attachWebview}
            src={surface.entryUrl}
            partition={surface.partition}
            className="min-h-0 flex-1 bg-background"
          />
        </div>
      )}
    </div>
  );
}
