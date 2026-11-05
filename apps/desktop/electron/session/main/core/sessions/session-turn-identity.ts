import type { TranscriptTurn } from '@gugu/session-core/acp/client';

import { withTranscriptTurnIdentity } from '@shared/core/sessions/transcript-turn-identity';
export { rewriteTurnId } from '@shared/core/sessions/transcript-turn-identity';

/**
 * 把一条回合按**库里的序号**重新编号（#5381）。
 *
 * ⚠️ 运行时那份回合序号**每次重开会话都从 0 重数**，而 `turn.id` 与它下面所有条目的 id 都由它
 * 派生（`${conversationId}:turn:${index}`、`${turnId}:message:…`）。于是一条跨过重启的会话，
 * 库里会出现**两条 id 完全相同的回合**——实测:第 5 行的 turn.id 与第 3 行逐字相同。
 *
 * 后果不是「显示得不好看」：id 是转录的主键，`scrollToItem`、按 id 定位、折叠状态、
 * 框架的 keying 全靠它。两条不同的回合共用一个 id，这些一起错位。而且它**只在跨重启的会话上
 * 发作** —— 正是这个功能存在的那个场景。
 *
 * 重编号只动 id 那几个字段（`id` 与 `parentId`，两者都以 turn id 为前缀），
 * ❌ 不做整段 JSON 的字符串替换：消息正文里恰好出现同样的字符串就会被误伤。
 */
export function renumberStoredTurn(
  turn: TranscriptTurn,
  sessionId: string,
  storeSeq: number
): TranscriptTurn {
  return withTranscriptTurnIdentity(turn, `${sessionId}:turn:s${storeSeq}`, storeSeq);
}
