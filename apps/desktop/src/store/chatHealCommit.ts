// R6 — 补洞(healMessageGap)取回的行因快照 epoch 变了(补洞在途时发生了删除/清空/回最新页等)被
// applyMessagesSnapshot 拒收时,从前静默丢弃而 listener 照常成功 ⇒ 这条 message_created 被确认,
// 取回的新消息却从没进窗口,要等下一条事件才出现。现在:会话仍在屏上 ⇒ 抛错,让修订派发按退避重补
// (重补会用新的 epoch 和游标);会话已切走 ⇒ 不必补,重新打开时会按游标冷拉。

export class SupersededHealError extends Error {
  constructor(chatId: string) {
    super(`heal result for chat ${chatId} was superseded by a newer snapshot; retrying`)
    this.name = 'SupersededHealError'
  }
}

export function commitHealedMessages(io: {
  chatId: string
  /** 落窗;返回 false = 快照 epoch 已变,被拒收。 */
  apply: () => boolean
  stillActive: () => boolean
}): void {
  if (io.apply()) return
  if (!io.stillActive()) return
  throw new SupersededHealError(io.chatId)
}
