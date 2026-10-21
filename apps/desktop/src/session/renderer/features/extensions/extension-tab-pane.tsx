import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { extensionSurfaceStore } from './extension-surface-store';
import { ExtensionTabToolbar } from './extension-tab-toolbar';

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
  filePath,
  projectId,
}: {
  extensionId: string;
  /** `<extensionId>.<tabName>` — which contribution this surface is drawing. */
  tabKind: string;
  /** Null: the pane is in no session yet (the draft panel). */
  sessionId: string | null;
  tabId: string;
  /**
   * The file this tab was opened for, when it was opened because the extension
   * claimed that file type. Passed to the bind call so the surface can read it
   * from `getContext()` — the host decides which file a claimed tab is showing,
   * never the surface.
   */
  filePath?: string;
  /** G1 With `filePath` and no session: the project whose folder the file is in (a page opened beside another). */
  projectId?: string;
}) {
  const { translate } = useSessionMessages();
  const [surface, setSurface] = useState<ExtensionSurface | null>(null);
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Not looked at while its retained session page is hidden (@@@retained-session-pages).
  const shown = useContext(PageShownContext);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const reportLayoutRef = useRef<(() => void) | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
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
      layoutTeardownRef.current?.();
      layoutTeardownRef.current = null;
      extensionSurfaceStore.setWebContentsId(sessionId, tabId, null);
    },
    [sessionId, tabId]
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

  const attachWebview = useCallback(
    (element: BrowserWebviewElement | null) => {
      webviewRef.current = element;
      layoutTeardownRef.current?.();
      layoutTeardownRef.current = null;
      extensionSurfaceStore.setWebContentsId(sessionId, tabId, null);
      if (!element) return;
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
        void rpc.extensions
          .bindSurface({
            webContentsId: element.getWebContentsId(),
            extensionId,
            ...(sessionId ? { sessionId } : {}),
            tabId,
            tabKind,
            ...(filePath ? { filePath } : {}),
            ...(projectId ? { projectId } : {}),
          })
          .then((result) => {
            if (!result.success) {
              log.warn('Extension surface binding refused:', result.error);
              return;
            }
            // Only after the bind lands: a layout report for an unbound surface
            // has nowhere to go, and would be dropped silently.
            startLayoutReports(element.getWebContentsId());
            // Host chrome draws this tab's declared entries elsewhere; this is
            // how a click there finds the surface that is actually running.
            extensionSurfaceStore.setWebContentsId(sessionId, tabId, element.getWebContentsId());
          })
          .catch((error: unknown) => {
            log.warn('Extension surface binding failed:', error);
          });
      });
    },
    [extensionId, filePath, projectId, startLayoutReports, sessionId, tabId]
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
