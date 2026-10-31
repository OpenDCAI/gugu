import type { PendingRequest, SessionpageSessionRespondRequest } from '@gugu/session-core/session-record/contract';

// Browser isolation tests replace only the Ask service boundary; no browser-owned question state.
export const hostAsks = new Map<string, Map<string, { request: PendingRequest; answered: (answer: unknown) => void; withdraw: () => void }>>();
export function ask(sessionId: string, request: PendingRequest, options: { signal?: AbortSignal }) {
  return new Promise<unknown>(resolve => {
    const entries = hostAsks.get(sessionId) ?? new Map();
    hostAsks.set(sessionId, entries);
    const finish = (answer: unknown) => { entries.delete(request.itemId); if (!entries.size) hostAsks.delete(sessionId); resolve(answer); };
    const withdraw = () => finish('withdrawn');
    entries.set(request.itemId, { request, answered: finish, withdraw });
    options.signal?.addEventListener('abort', withdraw, { once: true });
  });
}
export async function respond(input: SessionpageSessionRespondRequest) {
  const entry = hostAsks.get(input.conversationId)?.get(input.itemId);
  if (!entry) return { ok: true, value: { accepted: false } };
  entry.answered(input);
  return { ok: true, value: { accepted: true } };
}
export function withdrawAll(sessionId?: string, source?: string) {
  for (const [id, entries] of hostAsks) if (!sessionId || id === sessionId) {
    for (const entry of [...entries.values()]) if (!source || entry.request.origin?.source === source) entry.withdraw();
  }
}
