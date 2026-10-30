import { eq, like } from 'drizzle-orm';
import { db, type AppDb } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';

type InboxDb = Pick<AppDb, 'select' | 'insert'>;
type Target = { sessionId: string; projectId: string };
const PREFIX = 'native-conversation-inbox:';
const listeners = new Set<() => void>();
let activeHost: object | null = null;

/** Written only beside a new live personal turn. Opening/provisioning/replaying a task never requests a DM. */
export function queueNativeConversationInbox(sessionId: string, source: InboxDb): boolean {
  const key = PREFIX + sessionId;
  const existing = source.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
  if (existing) return !JSON.parse(existing.value).chatId;
  const session = source.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error(`Native inbox session is missing: ${sessionId}`);
  source.insert(kv).values({ key, value: JSON.stringify(session), updatedAt: Date.now() }).onConflictDoNothing().run();
  return true;
}

export function pendingNativeConversationInbox(source: InboxDb = db): Target[] {
  return source.select({ key: kv.key, value: kv.value }).from(kv).where(like(kv.key, PREFIX + '%')).all().flatMap(row => {
    const value = JSON.parse(row.value) as { projectId: string; chatId?: string };
    if (typeof value.projectId !== 'string' || !value.projectId || value.chatId !== undefined && (typeof value.chatId !== 'string' || !value.chatId)) throw new Error(`Invalid native inbox request: ${row.key}`);
    const sessionId = row.key.slice(PREFIX.length);
    const exists = source.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
    return value.chatId || !exists ? [] : [{ sessionId, projectId: value.projectId }];
  });
}

export function publishNativeConversationInbox(): void { for (const listener of listeners) listener(); }

/** Resume only persisted owner-exchange requests, never enumerate agents or derive requests from startup history. */
export function startNativeConversationInboxHost(deps: {
  open(target: Target): Promise<string>;
  failed(error: unknown): void;
}) {
  if (activeHost) throw new Error('Native conversation inbox host is already running');
  const token = {}; activeHost = token;
  let stopped = false;
  let requested = false;
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
        for (const target of pendingNativeConversationInbox()) {
          if (stopped) break;
          try {
            const chatId = await deps.open(target);
            if (!chatId) throw new Error(`Native inbox address is empty: ${target.sessionId}`);
            if (stopped) break;
            db.insert(kv).values({ key: PREFIX + target.sessionId, value: JSON.stringify({ projectId: target.projectId, chatId }), updatedAt: Date.now() })
              .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify({ projectId: target.projectId, chatId }), updatedAt: Date.now() } }).run();
            reported.delete(target.sessionId);
          } catch (error) {
            if (!reported.has(target.sessionId)) { reported.add(target.sessionId); deps.failed(error); }
          }
        }
      } while (requested && !stopped);
    })().finally(() => {
      running = null;
      if (!stopped && pendingNativeConversationInbox().length) {
        retry = setTimeout(kick, 15_000); retry.unref?.();
      }
    });
    return running;
  };
  const kick = () => { requested = true; void flush().catch(deps.failed); };
  listeners.add(kick);
  kick();
  return { flush, dispose: () => { stopped = true; clearTimeout(retry); listeners.delete(kick); if (activeHost === token) activeHost = null; } };
}
