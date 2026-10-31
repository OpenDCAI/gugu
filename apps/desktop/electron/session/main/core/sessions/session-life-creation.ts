import type { Session } from '@shared/core/sessions/sessions';
import { sessionLife } from './session-life';

/**
 * A new ACP session's creation turns become its first pending rows, so the first start carries no queue of its
 * own. The first turn of a chat-page / dispatched task is typed so its gugu message lands before it is sent.
 * Without any turn the person opened an empty task: that is an explicit start.
 */
export function admitCreationTurns(session: Pick<Session, 'id' | 'initialQueue' | 'initialMessageId' | 'startupOrigin' | 'taskChatId'>): void {
  const queue = session.initialQueue ?? [];
  const life = sessionLife();
  const landsFirst = Boolean(session.initialMessageId && (session.startupOrigin === 'chat-page' || session.taskChatId));
  queue.forEach((turn, index) => {
    // The first turn keeps the stable id its creation surface minted (the landed gugu message uses it too).
    const messageId = index === 0 && session.initialMessageId ? session.initialMessageId : `${session.id}:creation:${index}`;
    life.enqueue({
      sessionId: session.id, messageId, text: turn.text, kind: 'ordinary',
      turn: index === 0 && landsFirst ? { kind: 'chat-page-first-turn' }
        : { kind: 'prompt', origin: turn.origin, ...(turn.hiddenContext ? { hiddenContext: turn.hiddenContext } : {}) },
    });
  });
  if (!queue.length) life.start(session.id, 'user-open');
}
