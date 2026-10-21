// #7348 本机那一次开通没在等的时间里走完,谁来接着做。
//
// 开通页等它起来的时长有限(约 90 秒);新电脑第一次装,要先下载连 Claude 的组件,常常超过这个时长 —— 开通页于是报「还在启动」、
// 丢下后半段(落定 → 完成,完成那一步才把「让它先开口」那条交出去)。而它的身份那时已经有了,咕咕那一格画的是它的聊天,
// 开通页不会再出现;只在开通页接着做 = 永远接不上:它不先开口,开通记录一直挂着。
// ⇒ 由一直挂着的壳接着做:有它、又有没走完的那一次,就一直接着推,直到走完或真失败。

import type { ProvisionResumeRecord } from './agentProvision'

export type FinishLocalAssistantDeps = {
  /** 这台电脑上没走完的那一次;没有 = null。读不到抛错。 */
  pending: () => ProvisionResumeRecord | null
  /** 接着推一次(同一单,幂等);还没起来抛 still-starting,真失败抛 failed。 */
  resume: (record: ProvisionResumeRecord) => Promise<unknown>
  /** 这个失败是不是终局(再推也一样:真失败、那一单已被收回……);不是 = 它还没起来,过一会儿再推。 */
  isFinal: (error: unknown) => boolean
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  warn: (detail: Record<string, unknown>, message: string) => void
}

/** 第一次重试前等多久;之后每次翻倍,封顶 FINISH_RETRY_MAX_MS。 */
export const FINISH_RETRY_FIRST_MS = 15_000
export const FINISH_RETRY_MAX_MS = 120_000

/** 接着把没走完的那一次推完;返回停下的函数(壳卸载 / 换账号时调)。没有没走完的就什么都不做。 */
export function keepFinishingLocalAssistant(deps: FinishLocalAssistantDeps): () => void {
  let stopped = false
  let timer: unknown = null
  let delay = FINISH_RETRY_FIRST_MS

  const later = () => {
    if (stopped) return
    timer = deps.setTimer(() => void step(), delay)
    delay = Math.min(delay * 2, FINISH_RETRY_MAX_MS)
  }

  const step = async () => {
    if (stopped) return
    let record: ProvisionResumeRecord | null
    try {
      record = deps.pending()
    } catch (error) {
      deps.warn({ error: String(error) }, 'read pending local assistant failed')
      return
    }
    if (!record) return
    try {
      await deps.resume(record)
      return
    } catch (error) {
      if (stopped) return
      // 终局:再推也只会同样失败 —— 停,原因进日志(❌ 每两分钟撞一次同一堵墙)。
      if (deps.isFinal(error)) {
        deps.warn({ error: String(error) }, 'finish local assistant setup failed')
        return
      }
      deps.warn({ error: String(error) }, 'local assistant setup not finished yet; retrying')
    }
    later()
  }

  void step()
  return () => {
    stopped = true
    if (timer !== null) deps.clearTimer(timer)
  }
}
