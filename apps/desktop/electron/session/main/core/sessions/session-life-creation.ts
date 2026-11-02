import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionLife } from './session-life';
import { mapSessionRowToSession } from './utils';

/**
 * A new ACP session's creation turns are admitted at its launch, once per creation entry: the launch of a session made
 * elsewhere (another machine, the phone, a task card, an automation: launchCreatedSession), a spawn (startSpawnedSession),
 * agent.create, and for the desktop task page its own provision request (admitFirstMessages). Mounting a workspace never
 * admits them. Their message ids are stable, so a turn reached again (a replayed launch, a page opening a child its
 * launch already admitted) is the same single row.
 *
 * They become its first pending rows, so the first start carries no queue of its own. The first turn of a chat-page / dispatched task is typed so its gugu message lands before it is sent.
 * Without any turn the person opened an empty task: that is an explicit start.
 */
export function admitCreationTurns(session: CreationTurns): void {
  if (!enqueueCreationTurns(session)) sessionLife().start(session.id, 'user-open');
}

type CreationTurns = Pick<Session, 'id' | 'initialQueue' | 'initialMessageId' | 'startupOrigin' | 'taskChatId'>;

/**
 * The desktop task page's launch: it creates its own session, then asks for its workspace; once that exists (a fresh
 * profile's first workspace is only registered then), the session's creation turns are admitted (their enqueue starts
 * it). An empty task is started by the page itself when it opens. `initialQueue` is only read while it never ran.
 */
export async function admitFirstMessages(sessionId: string): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const session = mapSessionRowToSession(row);
  if (session.runtime === 'acp' && session.initialQueue?.length) enqueueCreationTurns(session);
}

/**
 * The creation turns as the session's first pending rows (idempotent: stable message ids). Returns how many there are;
 * a desktop task page that creates its own session starts an empty one itself (lifeStart on open).
 */
export function enqueueCreationTurns(session: CreationTurns): number {
  const queue = session.initialQueue ?? [];
  const life = sessionLife();
  const landsFirst = Boolean(session.initialMessageId && (session.startupOrigin === 'chat-page' || session.taskChatId));
  queue.forEach((turn, index) => {
    // The first turn keeps the stable id its creation surface minted (the landed gugu message uses it too).
    const messageId = index === 0 && session.initialMessageId ? session.initialMessageId : `${session.id}:creation:${index}`;
    life.enqueue({
      sessionId: session.id, messageId, text: turn.text, kind: turn.kind ?? 'ordinary',
      turn: index === 0 && landsFirst ? { kind: 'chat-page-first-turn' }
        : { kind: 'prompt', origin: turn.origin, ...(turn.hiddenContext ? { hiddenContext: turn.hiddenContext } : {}) },
    });
  });
  return queue.length;
}

/**
 * A creation that already needs the session's identity (agent.create, an App spawn) binds it first: identity is
 * its own persistent fact and the identity stage later reads it as bound. No half state: a binding whose row could
 * not be written is removed in the same step and the failure is raised; a failed binding creates nothing.
 */
export async function bindIdentityThenCreate<T>(bind: () => Promise<void>, create: () => Promise<T>, unbind: () => Promise<void>): Promise<T> {
  await bind();
  try {
    return await create();
  } catch (error) {
    await unbind();
    throw error;
  }
}

const creating = new Set<string>();

/**
 * One create per existing identity at a time: its binding is unique, so a concurrent second create for the same
 * agent is refused loudly instead of racing to rebind it. Returns the release for when the create settles.
 */
export function claimIdentityCreation(agentUserId: string): () => void {
  if (creating.has(agentUserId)) throw new Error(`agent ${agentUserId} is already being created on this device; its binding is unique`);
  creating.add(agentUserId);
  return () => { creating.delete(agentUserId); };
}
