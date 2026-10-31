/**
 * 乐观行:已经发出、真的那一轮还没开出来的那一句。
 *
 * 转录(ChatRoot)与对话左缘的时间线都把它当成一轮来画,所以「它长什么样」只在这里定一次 ——
 * 两处各拼一份,交接给真的那一轮时总有一处对不上(位置跳、刻度晚到)。
 */
import type { ChatAttachment, TranscriptTurn } from '@session-chat/model';

export type PendingPrompt = {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  /**
   * 发出的时刻。只用来定这一句落在哪一天(日期分隔):真的那一轮开出时也带着时刻,有了它两边上下文一样,
   * 交接时那句话不跳。❌ 不是这一轮的计时起点 —— 这时时间头是占位(`placeholderTurnHeader`),不数秒。
   */
  sentAt?: number;
};

/** 乐观行画成的那一轮:只有人说的那一句。 */
export function pendingPromptTurn(prompt: PendingPrompt): TranscriptTurn {
  const turn = {
    id: `pending:${prompt.id}:turn`,
    seq: 0,
    initiator: 'user',
    ...(prompt.sentAt !== undefined ? { startedAt: prompt.sentAt } : {}),
    items: [
      {
        kind: 'message',
        id: prompt.id,
        seq: 0,
        role: 'user',
        text: prompt.text,
        attachments: prompt.attachments,
      } as TranscriptTurn['items'][number],
    ],
  } satisfies TranscriptTurn;
  return turn;
}
