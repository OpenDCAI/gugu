// @@@4439 ack-seq-jump 修复卫星(mutators-bag 抽法,同 chatRealtimeMutations;god-file 冻结下的独立居所)。
// 权威单行摄入(出站 ack / 附件回读 / sessionpage host,seq 可跳跃)是唯一绕过页式取数的窗口写入;而
// realtime heal 与冷启增量都拿「窗口 max seq」当**已对服务端验证过的连续尾**游标。摄入行的 seq 越过
// 窗口旧尾 +1 时(与对端写库交错落库,中间有本窗口从未取过的入站行),必须立即从旧尾重验证,否则被
// 越过的行永久沉在游标下方:realtime / 下一次发送 / reload 三路取数全部漏掉它(#4439:DB 有行,
// 前端不渲染)。
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../lib/chat'
import { rendererLogger } from '../lib/log'
import { NEWER_PAGE, seqJumpRepairCursor } from './chatMessageWindow'

const log = rendererLogger('chat/seq-jump-repair')

export interface SeqJumpRepairIo {
  userId(): string | null
  windowRows(chatId: string): MessageItem[] | undefined
  snapshotEpoch(chatId: string): number
  revalidateInFlight: Set<string>
  applyMessagesSnapshot(chatId: string, msgs: MessageItem[], readSeqs: Record<string, number>, epoch: number): void
  refreshMessages(chatId: string): Promise<void>
}

// @@@1888 同则的轻量重验证:一页主线 delta,结果侧定真(空/短页 = 群话题 seq 膨胀的假洞,有行 = 补齐,
// 整页 = 交给权威重载)。刻意不复用 healMessageGap——那是重连恢复原语,附带话题快照/摘要/overlay
// 重验证(约 5 个查询);群里有话题流量时每条主线 ack 的 seq 都会跳,发送热路径只付得起这一页 delta。
async function reverifySeqRange(io: SeqJumpRepairIo, chatId: string, sinceSeq: number): Promise<void> {
  const userId = io.userId()
  if (!userId) return
  const epoch = io.snapshotEpoch(chatId)
  io.revalidateInFlight.add(chatId)
  try {
    const [msgs, readSeqs] = await Promise.all([
      chatService.getMessages(chatId, userId, 'loadNewer', NEWER_PAGE, undefined, sinceSeq),
      chatService.getOtherMembersReadSeqs(chatId, userId),
    ])
    if (msgs.length > 0) io.applyMessagesSnapshot(chatId, msgs, readSeqs, epoch)
    if (msgs.length >= NEWER_PAGE) await io.refreshMessages(chatId)
  } finally {
    io.revalidateInFlight.delete(chatId)
  }
}

/**
 * settled 权威行合并进窗口后调度。先让出一个 task 等该合并 commit,再对「窗口现状(不含该行自身)」
 * 重判跳号,有跳号才修:
 * - 让出 task 是竞态修复,不是优化:修复的重取以窗口缓存为合并基线,而触发它的那次合并还在 React
 *   更新队列里——不等 commit 就取数,空快照会以陈旧的空基线把刚并入的权威行冲掉(ChatProviderRealtime
 *   「空 refresh 不当权威删除」单测抓到的交错;真实网络往返天然晚于 commit,这里把它变成确定性顺序)。
 * - post-commit 重判(剔除自身)一并消解两类假阳性:同 tick 连续摄入(前一行尚未 commit,旧尾读小了)
 *   与已被 realtime heal 抢先补齐的洞(白查一页)。首条消息(seq 恒从 1 起,004_chat_extensions.sql)
 *   在纯函数层就判不出跳号。
 * - 修复降级链:窗口无已验证尾(cursor=0)直接权威重载(❌ 不从 0 正序拉最老一页——重启恢复投递到
 *   本次没打开过的长会话时,那会把最老 200 行短暂写进 L2);delta 失败降级权威重载,再失败大声报错
 *   (此时窗口可能缺交错入站行,e2e 的 console guard 会把它变红)。
 */
export async function repairSeqJumpAfterIngest(io: SeqJumpRepairIo, ingested: MessageItem): Promise<void> {
  const chatId = ingested.chat_id
  await new Promise((resolve) => setTimeout(resolve, 0))
  const rows = io.windowRows(chatId)?.filter((row) => row.id !== ingested.id)
  const sinceSeq = seqJumpRepairCursor(rows, ingested.seq)
  if (sinceSeq === null) return
  try {
    if (sinceSeq === 0) await io.refreshMessages(chatId)
    else await reverifySeqRange(io, chatId, sinceSeq)
  } catch (err) {
    log.error({ chatId, sinceSeq, error: err }, 'reverify failed, degrading to authoritative reload')
    try {
      await io.refreshMessages(chatId)
    } catch (err2) {
      log.error({ chatId, sinceSeq, error: err2 }, 'authoritative reload failed — window may be missing interleaved inbound rows')
    }
  }
}
