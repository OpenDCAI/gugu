import type { WebContents } from 'electron';
import { isSupportedBrowserNavigationUrl } from './browser-navigation';
import { pageNetworkEvent } from './page-network-events';

type PageEvent = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type PageProtocolOptions = {
  ready?: Promise<void>;
  /** Owning connection lifetime. Individual commands take their own signal in send(). */
  signal?: AbortSignal;
  capture?: (params: Record<string, unknown>) => Promise<unknown>;
};

// Explicitly page-scoped operations used by the task-page driver. New CDP methods are denied
// until reviewed; cookie/storage/Fetch/IO/browser-wide commands must not inherit this permission.
const PAGE_METHODS = new Set(`
  Runtime.enable Runtime.disable Runtime.evaluate Runtime.callFunctionOn Runtime.getProperties
  Runtime.releaseObject Runtime.releaseObjectGroup Runtime.runIfWaitingForDebugger
  Runtime.addBinding Runtime.removeBinding Runtime.getIsolateId
  Page.enable Page.disable Page.getFrameTree Page.getLayoutMetrics Page.navigate Page.reload
  Page.getNavigationHistory Page.navigateToHistoryEntry Page.stopLoading Page.captureScreenshot
  Page.createIsolatedWorld Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument
  Page.setLifecycleEventsEnabled Page.handleJavaScriptDialog Page.setInterceptFileChooserDialog
  DOM.enable DOM.disable DOM.getDocument DOM.describeNode DOM.resolveNode DOM.requestNode
  DOM.querySelector DOM.querySelectorAll DOM.getBoxModel DOM.getContentQuads DOM.getOuterHTML
  DOM.scrollIntoViewIfNeeded DOM.setFileInputFiles DOM.getFrameOwner
  Accessibility.enable Accessibility.disable Accessibility.getFullAXTree Accessibility.getPartialAXTree
  Input.dispatchKeyEvent Input.dispatchMouseEvent Input.dispatchTouchEvent Input.insertText Input.imeSetComposition
  Input.setInterceptDrags Input.dispatchDragEvent
  Emulation.setFocusEmulationEnabled Emulation.setDeviceMetricsOverride Emulation.clearDeviceMetricsOverride
  Emulation.setTouchEmulationEnabled Emulation.setEmulatedMedia Emulation.setDefaultBackgroundColorOverride
  Network.enable Network.disable Network.setCacheDisabled Network.getResponseBody Network.getRequestPostData
  Log.enable Log.disable Performance.enable Performance.disable Performance.getMetrics
`.trim().split(/\s+/));

/** A host-selected page, borrowed without owning its navigation, partition or presentation. */
export interface PageProtocol {
  readonly attached: boolean;
  send(method: string, params?: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<unknown>;
  onMessage(listener: PageEvent): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(reason?: string): void;
}

/**
 * Raw page protocol for App control. The host selects the contents before calling this function;
 * there is no contents-id lookup, target enumeration, Playwright adapter or browser tool here.
 * Closing/cancelling a lease releases its debugger, never the person's page or site login.
 */
export function createPageProtocol(contents: WebContents, options: PageProtocolOptions = {}): PageProtocol {
  const debuggerApi = contents.debugger;
  const lifetime = new AbortController();
  const messages = new Set<PageEvent>();
  const closures = new Set<(reason: string) => void>();
  const children = new Map<string, string | undefined>();
  let attached = false;
  let closed: string | undefined;
  let attaching: Promise<void> | undefined;

  const assertLive = () => {
    if (closed || contents.isDestroyed()) throw new Error(closed ?? 'the browser tab was closed');
    options.signal?.throwIfAborted();
  };
  const bounded = <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const signals = [lifetime.signal, ...(signal ? [signal] : [])];
    const done = () => { signals.forEach(value => value.removeEventListener('abort', abort)); };
    const abort = () => { done(); reject(signals.find(value => value.aborted)?.reason); };
    // Always observe the native result, including cancellation after dispatch. It is never replayed.
    operation.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
    if (signals.some(value => value.aborted)) abort();
    else signals.forEach(value => value.addEventListener('abort', abort, { once: true }));
  });
  const ready = options.ready ?? Promise.resolve();
  void ready.catch(() => {});

  function ensureAttached(): Promise<void> {
    attaching ??= bounded(ready).then(() => {
      assertLive();
      if (debuggerApi.isAttached()) throw new Error('the page debugger is already in use');
      // Native attach can emit synchronously, before the first command is sent.
      attached = true;
      try { debuggerApi.attach('1.3'); }
      catch (error) { attached = false; throw error; }
    });
    return attaching;
  }

  function onMessage(_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) {
    if (closed || !attached || (sessionId && !children.has(sessionId))) return;
    if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') children.set(params.sessionId, sessionId);
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      const remove = (id: string) => {
        for (const [child, parent] of children) if (parent === id) remove(child);
        children.delete(id);
      };
      remove(params.sessionId);
    }
    const visible = pageNetworkEvent(method, params);
    for (const listener of messages) listener(method, visible, sessionId);
  }
  const onDetach = (_event: unknown, reason: string) => close(`debugger detached: ${reason}`);
  const onDestroyed = () => close('the browser tab was closed');
  const onAbort = () => close('the browser connection was cancelled');

  function close(reason = 'the browser connection was closed') {
    if (closed) return;
    closed = reason;
    lifetime.abort(new Error(reason));
    options.signal?.removeEventListener('abort', onAbort);
    debuggerApi.removeListener('message', onMessage);
    debuggerApi.removeListener('detach', onDetach);
    contents.removeListener('destroyed', onDestroyed);
    if (attached && !contents.isDestroyed() && debuggerApi.isAttached()) {
      try { debuggerApi.detach(); } catch { /* Native destruction may have won the race. */ }
    }
    attached = false;
    children.clear();
    messages.clear();
    for (const listener of closures) listener(reason);
    closures.clear();
  }

  debuggerApi.on('message', onMessage);
  debuggerApi.on('detach', onDetach);
  contents.once('destroyed', onDestroyed);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  return {
    get attached() { return attached; },
    async send(method, params = {}, sessionId, signal) {
      signal?.throwIfAborted();
      assertLive();
      if (sessionId && !children.has(sessionId)) throw new Error('unknown page session');
      const targetCommand = method === 'Target.getTargetInfo' && !Object.hasOwn(params, 'targetId')
        || method === 'Target.setAutoAttach' && params.flatten === true
        || method === 'Target.detachFromTarget' && typeof params.sessionId === 'string' && children.has(params.sessionId);
      if ((!PAGE_METHODS.has(method) && !targetCommand) || method.startsWith('Target.') && Object.hasOwn(params, 'targetId')) {
        throw new Error(`page protocol: ${method} is not available (this connection drives one tab)`);
      }
      if (method === 'Page.navigate' && (typeof params.url !== 'string' || !isSupportedBrowserNavigationUrl(params.url))) {
        throw new Error('page protocol: unsupported navigation URL');
      }
      if (method === 'Input.dispatchDragEvent' && [params.files, (params.data as { files?: unknown } | undefined)?.files].some(files => Array.isArray(files) && files.length > 0)) {
        throw new Error('page protocol: dragging local files is not available');
      }
      await bounded(ready, signal);
      assertLive();
      signal?.throwIfAborted();
      if (sessionId && !children.has(sessionId)) throw new Error('unknown page session');
      await ensureAttached();
      assertLive();
      signal?.throwIfAborted();
      return bounded(method === 'Page.captureScreenshot' && !sessionId && options.capture
        ? options.capture(params)
        : debuggerApi.sendCommand(method, params, sessionId), signal);
    },
    onMessage(listener) {
      if (!closed) {
        messages.add(listener);
        void ensureAttached().catch(error => close(error instanceof Error ? error.message : String(error)));
      }
      return () => { messages.delete(listener); };
    },
    onClose(listener) {
      if (closed) listener(closed);
      else closures.add(listener);
      return () => { closures.delete(listener); };
    },
    close,
  };
}
