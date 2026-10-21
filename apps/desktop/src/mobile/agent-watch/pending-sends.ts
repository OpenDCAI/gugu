import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { AgentWatchTimeline } from './agent-watch-store'

/**
 * 手机上**刚按了发送、那台机器还没报出来**的那几句。
 *
 * 为什么要有:发送是一次到那台机器的往返,而那台机器上的 agent 若没在跑,它要先把引擎拉起来
 * (claude `--resume` 那条,见 write-bridge 的 `ensureAcpSessionLive`)、再投进去、再等记录写下这一行、
 * 再推回手机 —— 十几秒里屏幕上什么都没有:输入框清空了,自己那句话哪儿都看不见
 * (owner 2026-09-27 真机:「往往要等很久才能有反馈」)。
 *
 * 这里只画**已经交出去**的那句,与桌面会话页的乐观消息(acp-chat-store 的 pendingPrompt)同一件事:
 * 按下发送那一刻出现,那台机器报出它来就让位 —— 记录里那一行到了,或者它出现在那台机器的队列里(agent 忙,
 * 排着);发送失败就撤掉(失败照旧由 actionError 报,❌ 留着冒充已发出)。排着的那句从此由队列画,❌ 两份并存。
 * 纯函数、单独一份,判据才喂得动合成输入。
 */
export type PendingSend = {
  id: string
  text: string
  /**
   * 发送那一刻时间线里已有的用户消息 id。回显只可能排在它们**后面**(见 `candidates`):
   * ❌ 只看「不在这个集合里」—— 往上翻出来的更早历史也不在集合里,却排在前面。
   */
  baseline: ReadonlySet<string>
  /** 那台机器已受理(RPC 成功返回)。受理前 ❌ 按「第一条新出现的用户消息」认领 —— 那可能是别处发的。 */
  accepted: boolean
}

type UserLine = { id: string; text: string }

/** 那台机器已经报出来的用户输入:记录里的用户消息,接着是还排着的(排在它们后面,还没进记录)。 */
function userLines(turns: readonly TranscriptTurn[], queued: AgentWatchTimeline['queuedPrompts']): UserLine[] {
  const out: UserLine[] = []
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'message' && item.role === 'user') out.push({ id: item.id, text: item.text })
    }
  }
  return [...out, ...queued]
}

export function userMessageIds(turns: readonly TranscriptTurn[], queued: AgentWatchTimeline['queuedPrompts'] = []): Set<string> {
  return new Set(userLines(turns, queued).map((line) => line.id))
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * 这一句的回显**可能**是哪几行:排在基线里最后一行之后、且不在基线里的用户消息。
 * 按位置而不是按「不在基线里」:懒加载更早的轮(loadOlder)会在前面插进一批基线里没有的行,
 * 它们既可能被「按先后」认走,也可能碰巧含着同一句短话(「好」)被「按原文」认走 —— 乐观那一行就提前消失了。
 * 基线一行都找不到(发送时还没有用户消息,或记录换了世代整份重来)就从头算。
 */
function candidates(lines: readonly UserLine[], send: PendingSend): UserLine[] {
  let last = -1
  lines.forEach((line, index) => {
    if (send.baseline.has(line.id)) last = index
  })
  return lines.slice(last + 1).filter((line) => !send.baseline.has(line.id))
}

/**
 * 回显到了的那几句去掉,返回还在路上的。一句都没变时原样返回同一个数组(调用方据此跳过 setState)。
 *
 * 只在 `candidates` 里认(发送之后才出现、排在已有那些后面的行)。认领分三道,前一道认走的行后一道不再用:
 *  ① **逐字相等**(空白折叠后):一行只顶一句 —— 连发两句「好」,第一句回来时第二句不该跟着消失。
 *  ② **包含原文**(只对已受理的):终端腿会把几句并成一次注入,记录里那一行比手机发的长。
 *     这一道不独占 —— 并成一行的几句,一行就能都认走。❌ 对还没受理的这么认:
 *     别处发来一句「好的」就会把手机这句「好」认走。
 *  ③ **按先后**(只对已受理的):原文认不出来,就按发送顺序认领一条还没被认走的新用户消息。
 *     这一道独占,一条记录只顶一句。❌ 对还没受理的这么认:那时新出现的用户消息只可能是别处发的。
 *     ❌ 认领咕咕投递(画成投递卡的那种):手机这一句原样进会话、从不包信封,投递是别处发来的 ——
 *     它和这一句前后脚到时被认走,这句就从屏上消失,直到它自己那一行回来。
 */
export function settlePendingSends(
  pending: readonly PendingSend[],
  turns: readonly TranscriptTurn[],
  queued: AgentWatchTimeline['queuedPrompts'] = [],
): readonly PendingSend[] {
  if (pending.length === 0) return pending
  const lines = userLines(turns, queued)
  const settled = new Set<string>()
  const exactClaimed = new Set<string>()
  for (const send of pending) {
    const want = flat(send.text)
    const hit = candidates(lines, send).find((line) => !exactClaimed.has(line.id) && flat(line.text) === want)
    if (hit) {
      settled.add(send.id)
      exactClaimed.add(hit.id)
    }
  }
  const claimed = new Set(exactClaimed)
  for (const send of pending) {
    if (settled.has(send.id) || !send.accepted) continue
    const want = flat(send.text)
    const hit = candidates(lines, send).find((line) => !exactClaimed.has(line.id) && flat(line.text).includes(want))
    if (hit) {
      settled.add(send.id)
      claimed.add(hit.id)
    }
  }
  for (const send of pending) {
    if (settled.has(send.id) || !send.accepted) continue
    const hit = candidates(lines, send).find((line) => !claimed.has(line.id) && readDeliveryEnvelope(line.text) === null)
    if (hit) {
      settled.add(send.id)
      claimed.add(hit.id)
    }
  }
  return settled.size === 0 ? pending : pending.filter((send) => !settled.has(send.id))
}
