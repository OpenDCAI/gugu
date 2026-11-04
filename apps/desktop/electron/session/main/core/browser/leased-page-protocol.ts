import type { WebContents } from 'electron';
import { anySignal } from '@gugu/core/shared/anySignal';
import { createPageProtocol, type PageProtocol } from './page-protocol';
import { LeasedPageInput } from './leased-page-input';

/** Fence undispatched commands, release dispatched controls, then let the owner detach the protocol. */
export function leasePageProtocol(contents: WebContents, options: { ready: Promise<void>; capture(params: Record<string, unknown>): Promise<unknown> }) {
  const commands = new AbortController(), input = new LeasedPageInput();
  const raw = createPageProtocol(contents, { ...options,
    sent: (method, params, sessionId, native) => input.sent(method, params, sessionId, native),
  });
  let closing: Promise<void> | undefined;
  const protocol: PageProtocol = { ...raw, get attached() { return raw.attached; },
    send: (method, params, sessionId, signal) => raw.send(method, params, sessionId, anySignal([signal, commands.signal])),
    maintain: (method, params, sessionId, signal) => raw.maintain!(method, params, sessionId, anySignal([signal, commands.signal])),
  };
  return { protocol, cleanup() {
    if (closing) return closing;
    commands.abort(new Error('The task page lease ended'));
    // A lost native connection must never be reattached just to release old input.
    closing = raw.attached ? input.release((method, params, sessionId) =>
      raw.send(method, params, sessionId, AbortSignal.timeout(5_000))) : Promise.resolve();
    return closing;
  } };
}
