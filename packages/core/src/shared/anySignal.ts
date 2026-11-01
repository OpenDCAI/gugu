/**
 * One signal that aborts when any of `signals` aborts, with that signal's reason. Absent entries are skipped, so a
 * caller writes `anySignal([callerSignal, timeout])` whether or not it was given a signal; a single signal is returned as
 * it is. The only place that touches `AbortSignal.any` (lint forbids it elsewhere): Android System WebView before 116
 * does not have it, and calling it there threw before the request was sent.
 *
 * Without the native function the combined signal is a controller's. Its listeners on the source signals hold it only
 * weakly and are removed when it aborts or is collected, so a long-lived source (a session, a grant) does not keep
 * every request it ever bounded.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal | null | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal != null);
  if (present.length === 1) return present[0]!;
  // eslint-disable-next-line no-restricted-properties -- the one native call, guarded.
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
  const controller = new AbortController();
  const aborted = present.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return controller.signal;
  }
  owners.set(controller.signal, controller);
  const combined = new WeakRef(controller);
  const detach = () => { for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener); };
  const listeners = present.map((signal) => [signal, () => {
    detach();
    combined.deref()?.abort(signal.reason);
  }] as const);
  for (const [signal, listener] of listeners) signal.addEventListener('abort', listener, { once: true });
  released.register(controller.signal, detach);
  return controller.signal;
}

/** A signal keeps its controller alive (a signal alone does not); the sources hold the controller only weakly. */
const owners = new WeakMap<AbortSignal, AbortController>();
const released = new FinalizationRegistry<() => void>((detach) => detach());
