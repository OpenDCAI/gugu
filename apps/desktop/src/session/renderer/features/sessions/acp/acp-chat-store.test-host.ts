// Shared host for the acp-chat-store tests (one copy instead of one per test file).
//
// ⚠️ `lib/ipc.ts` reads `window.electronAPI` while the module graph is being evaluated; without a bridge it
// installs a fail-loud stub, and `new AcpChatStore` → `getSharedChatContext()` → `preloadIssueMentionIcons`
// then throws `electronAPI.invoke is unavailable for integrations.list`. So the bridge has to be in place
// **before** the store module loads: call `installAcpChatStoreHost()` at the top level of the test file,
// then load the store with a dynamic `import('./acp-chat-store')` — never a static import, which would be
// hoisted above this call. Keep the call at the top level rather than in `beforeAll`: the import transforms
// the whole renderer graph and can outrun a hook budget under load, which turns every case into "skipped".
import { vi } from 'vitest';

type Invoke = (channel: string, ...args: never[]) => Promise<unknown>;
type EventOn = (channel: string, callback: (data: unknown) => void) => () => void;

export function installAcpChatStoreHost(
  invoke: Invoke = () => Promise.resolve([]),
  eventOn: EventOn = () => () => {},
): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      eventSend: () => {},
      eventOn,
      getPathForFile: () => '',
    },
  });
}

type Meta = { kind: 'seed' } | { kind: 'update'; mutationIds: string[] };

/** An in-memory live replica: what the host pushes, the store reads through `current()` / `onChange`. */
export function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: T, meta: Meta) => void>();
  const goneListeners = new Set<(error: { code: string }) => void>();
  return {
    current: () => value,
    onChange: (cb: (value: T, meta: Meta) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: (cb: (error: { code: string }) => void) => {
      goneListeners.add(cb);
      return () => goneListeners.delete(cb);
    },
    ready: Promise.resolve(),
    push(next: T, meta: Meta = { kind: 'update', mutationIds: [] }) {
      value = next;
      for (const listener of [...listeners]) listener(next, meta);
    },
    /** Reconnect refused for good: the runtime no longer has this instance (#7327). */
    gone() {
      for (const listener of [...goneListeners]) listener({ code: 'NOT_FOUND' });
    },
    listenerCount: () => listeners.size + goneListeners.size,
  };
}
