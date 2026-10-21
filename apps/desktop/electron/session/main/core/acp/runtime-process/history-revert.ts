type RevertInput = { sessionId: string; anchor: string };

/** A confirmed native revert must never be repeated just because its display-cache write failed. */
export function createHistoryReverter<M, R extends { success: boolean }>(deps: {
  boundary: (sessionId: string, anchor: string) => Promise<number | null>;
  revert: (input: RevertInput, meta?: M) => Promise<R>;
  truncate: (sessionId: string, boundary: number | null) => Promise<void>;
  finish: (sessionId: string) => Promise<unknown>;
}) {
  const pending = new Map<string, { anchor: string; boundary: number | null; result: R }>();
  const running = new Set<string>();
  return async (input: RevertInput, meta?: M): Promise<R> => {
    if (running.has(input.sessionId)) throw new Error('Conversation revert is in progress.');
    const previous = pending.get(input.sessionId);
    if (previous && previous.anchor !== input.anchor) {
      throw new Error('Finish saving the previous conversation revert before choosing another point.');
    }
    running.add(input.sessionId);
    try {
      let confirmed = previous;
      if (!confirmed) {
        const boundary = await deps.boundary(input.sessionId, input.anchor);
        const result = await deps.revert(input, meta);
        if (!result.success) return result;
        confirmed = { anchor: input.anchor, boundary, result };
        pending.set(input.sessionId, confirmed);
      }
      try {
        await deps.truncate(input.sessionId, confirmed.boundary);
        await deps.finish(input.sessionId);
      } catch (cause) {
        throw new Error('The provider history was reverted, but saving the display history failed. Retry this same revert to finish saving; sending remains blocked.', { cause });
      }
      pending.delete(input.sessionId);
      return confirmed.result;
    } finally { running.delete(input.sessionId); }
  };
}
