import type { WebContents } from 'electron';

type PageEvent = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type PageProtocolOptions = {
  ready?: Promise<void>;
  signal?: AbortSignal;
  capture?: (params: Record<string, unknown>) => Promise<unknown>;
};

/** A host-selected page, borrowed without owning its navigation, partition or presentation. */
export interface PageProtocol {
  readonly attached: boolean;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
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

  const assertLive = () => {
    if (closed || contents.isDestroyed()) throw new Error(closed ?? 'the browser tab was closed');
    options.signal?.throwIfAborted();
  };
  const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const done = () => lifetime.signal.removeEventListener('abort', abort);
    const abort = () => { done(); reject(lifetime.signal.reason); };
    // Always observe the native result, including cancellation after dispatch. It is never replayed.
    operation.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
    if (lifetime.signal.aborted) abort();
    else lifetime.signal.addEventListener('abort', abort, { once: true });
  });
  const ready = options.ready ?? Promise.resolve();
  void ready.catch(() => {});

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
    for (const listener of messages) listener(method, params, sessionId);
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
    async send(method, params = {}, sessionId) {
      assertLive();
      if (sessionId && !children.has(sessionId)) throw new Error('unknown page session');
      const targetCommand = method === 'Target.getTargetInfo' && !Object.hasOwn(params, 'targetId')
        || method === 'Target.setAutoAttach' && params.flatten === true
        || method === 'Target.detachFromTarget' && typeof params.sessionId === 'string' && children.has(params.sessionId);
      if ((/^(Browser\.|SystemInfo\.|Tethering\.|Target\.)/.test(method) && !targetCommand)
        || method.startsWith('Target.') && Object.hasOwn(params, 'targetId') || method === 'Page.close') {
        throw new Error(`page protocol: ${method} is not available (this connection drives one tab)`);
      }
      await bounded(ready);
      assertLive();
      if (sessionId && !children.has(sessionId)) throw new Error('unknown page session');
      if (!attached) {
        if (debuggerApi.isAttached()) throw new Error('the page debugger is already in use');
        debuggerApi.attach('1.3');
        attached = true;
      }
      return bounded(method === 'Page.captureScreenshot' && !sessionId && options.capture
        ? options.capture(params)
        : debuggerApi.sendCommand(method, params, sessionId));
    },
    onMessage(listener) { if (!closed) messages.add(listener); return () => { messages.delete(listener); }; },
    onClose(listener) {
      if (closed) listener(closed);
      else closures.add(listener);
      return () => { closures.delete(listener); };
    },
    close,
  };
}
