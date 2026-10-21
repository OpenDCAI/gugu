import type { TranscriptTurn } from '@gugu/session-core/acp';

/**
 * 上屏历史的拼接(#5381):往上翻出来的 + 库里那份 + 引擎里**还没落库**的那几轮。
 *
 * spec session-history-replay:历史由会话页自己持久化,重放降为「让 provider 恢复上下文 +
 * 补上本机没有的部分」。于是同一段历史可能同时出现在两处 —— 库里一份、引擎里一份。
 * **同一轮不得出现两次,也不得一轮都不出现**,这个函数就是那条约束的落点。
 *
 * ⚠️ 判重**按身份,不按条数**(评审 #2 / #3)。从前是「开场时引擎有几轮,之后就切掉前几条」,
 * 而引擎给的是**最后 100 轮的滑动窗口**:重放回来 ≥100 轮时,再聊一轮窗口还是 100 条,切完是空的,
 * 刚讲完的那一轮从屏幕上消失;重放 80 轮再聊 30 轮,窗口滑到第 10 轮起,切掉 80 条就丢了第 80–89 轮。
 * 现在两条判据都是身份:
 *   · 引擎那侧用 **seq**(运行时回合序号,单调递增,窗口怎么滑都不变)划开「开场时已有的」与「之后新增的」;
 *   · 新增的那些里,已经落库的按 **运行时原始 turn id** 认出来(库里那行记着它从哪一轮来),不再从引擎那侧重复出。
 */
export function composeHistoryTurns(input: {
  /**
   * 往上翻出来的更早那些回合，按时间由旧到新，**永远排在最前面**。
   * 游标保证它们严格早于 `stored`(或库里为空时早于 `runtime`)的第一条,首尾直接相接。
   */
  older?: readonly TranscriptTurn[];
  /** 库里从开场那一页的第一行一直到最新的那些行，按时间由旧到新。 */
  stored: readonly TranscriptTurn[];
  /** 引擎侧的已提交回合，由旧到新；调用方负责取全「边界之后」的那一段，不能只给一个窗口。 */
  runtime: readonly TranscriptTurn[];
  /**
   * 开场时引擎已有的最后一轮 seq + 1。seq 小于它的是开场前就在的(重放回来的、或面板重挂前聊过的),
   * 库里那份已经覆盖;只在库里非空时生效。
   */
  runtimeReplayEndSeq: number;
  /** 开场之后才落库的那些行来自引擎的哪几轮(运行时原始 turn id)。 */
  persistedRuntimeTurnIds?: ReadonlySet<string>;
}): TranscriptTurn[] {
  const older = input.older ?? [];
  // 库里为空 ⇒ 引擎是唯一来源,一条都不能少(老会话、刚从编程模式切过来的会话)。
  //
  // ⚠️ 这里**只判库里空不空**。❌ 别加「引擎没历史就用引擎那份」之类的条件:会话新开、provider 认不出
  // 旧会话、重放失败退回 `session/new` 时引擎那侧都是空的,那正是库里那份最该画出来的时候。
  if (input.stored.length === 0) {
    return [...older, ...input.runtime];
  }
  const persisted = input.persistedRuntimeTurnIds ?? new Set<string>();
  const pending = input.runtime.filter(
    (turn) => turn.seq >= input.runtimeReplayEndSeq && !persisted.has(turn.id)
  );
  return [...older, ...input.stored, ...pending];
}

/**
 * 侧边聊天(运行时分叉)画哪几轮(#6762):只画**在这条分叉里开出来的**回合。
 *
 * 有的家 fork 时把来源会话的历史重放进分叉(走 `session/load` 的那几家),那是给模型的上下文,
 * ❌ 不是这条侧边聊天里说过的话。重放出来的回合没有 `startedAt`(session-core `turn.ts` 的合同:重放没有
 * 真实时钟;`background-commands.ts` 也按它认重放),这里就按它认。
 *
 * ⚠️ ❌ 按「挂上那一刻引擎里已有几轮」去切:聊天面挂上会话之前从这个视图发出的话照样会开轮
 * (运行时在收到那一刻判准入),挂上之前就答完的那一轮会被当成来源前缀整轮藏掉 —— 问了、答了,屏上什么都没有。
 */
export function sideChatOwnTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  return turns.filter((turn) => turn.startedAt !== undefined);
}
