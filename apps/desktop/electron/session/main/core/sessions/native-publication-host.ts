import { onNativePublicationQueued, pendingNativePublications, saveNativePublication, type NativePublication, type NativePublicationContext } from './native-publication-journal';

let currentHost: { context(sessionId: string): Promise<NativePublicationContext | null> } | null = null;
export async function nativePublicationContext(sessionId: string, requireOwner = false): Promise<NativePublicationContext | null> {
  const host = currentHost;
  const context = await host?.context(sessionId) ?? null;
  if (requireOwner && host && !context) throw new Error('Native publication owner is not authenticated');
  return context;
}

/** Startup drains only explicit durable live admissions, never scans transcripts or activity previews. */
export function startNativeConversationPublicationHost(deps: {
  context(sessionId: string): Promise<NativePublicationContext | null>;
  address(entry: NativePublication): Promise<{ chatId: string; agentUserId: string }>;
  publish(entry: NativePublication & { chatId: string; agentUserId: string }): Promise<{ accountRevision: string; already: boolean }>;
  failed(error: unknown): void;
}) {
  if (currentHost) throw new Error('Native conversation publication host is already running');
  currentHost = deps;
  let stopped = false, requested = false;
  let running: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reported = new Set<string>();
  const flush = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    clearTimeout(retry);
    running = (async () => {
      do {
        requested = false;
        for (const original of pendingNativePublications()) {
          if (stopped) break;
          try {
            const context = await deps.context(original.sessionId);
            if (!context || context.ownerUserId !== original.ownerUserId) continue;
            if (context.deviceId !== original.deviceId || original.agentUserId && context.agentUserId !== original.agentUserId) throw new Error('Native publication binding changed');
            const address = original.chatId && original.agentUserId
              ? { chatId: original.chatId, agentUserId: original.agentUserId } : await deps.address(original);
            if (stopped) break;
            const entry = { ...original, ...address };
            // Freeze the complete destination before an uncertain HTTP attempt, including after a crash.
            saveNativePublication(entry);
            const ack = await deps.publish(entry);
            if (!/^(0|[1-9][0-9]*)$/.test(ack.accountRevision) || typeof ack.already !== 'boolean') throw new Error('Invalid native publication receipt');
            saveNativePublication({ ...entry, ack });
            reported.delete(entry.id);
          } catch (error) {
            if (!reported.has(original.id)) { reported.add(original.id); deps.failed(error); }
          }
        }
      } while (requested && !stopped);
    })().finally(() => {
      running = null;
      if (!stopped && pendingNativePublications().length) { retry = setTimeout(kick, 15_000); retry.unref?.(); }
    });
    return running;
  };
  const kick = () => { requested = true; void flush().catch(deps.failed); };
  const unlisten = onNativePublicationQueued(kick);
  kick();
  return { flush, dispose() { stopped = true; clearTimeout(retry); unlisten(); if (currentHost === deps) currentHost = null; } };
}
