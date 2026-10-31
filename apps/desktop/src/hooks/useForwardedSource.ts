// @@@5856 转发出处的 renderer hook ——「引自:某某线」(product spec)。
//
// 缓存与批量往返在 lib/forwardedSource.ts;这里只负责订阅与重绘。**放在 hooks/ 里是故意的**:
// scripts/checks/subject-scoped-hooks.mts 只扫这个目录,hook 搁在 lib 里就绕开了 #3922 那道登记闸。
import { useEffect, useState } from 'react'
import {
  forwardedSourceCache,
  requestForwardedSource,
  subscribeForwardedSource,
  type ForwardedSource,
} from '../lib/forwardedSource'

/**
 * 一条转发消息的出处线;`null` = 还没解析出来 / 没有出处 / 读者看不见那条线 —— 三者在界面上
 * 是同一种处置(退回只显「转发」),所以不必分开。
 *
 * 形状是 **keyed-map**(见 scripts/checks/subject-scoped-hook-registry.json):返回值在**渲染期**用当前
 * messageId 从模块级 cache 里取,自有 state 只是一个「来新数据了,重绘一次」的计数器。
 * ❌ 不把出处存进 state 再在 effect 里追 —— 那样换一条消息的那一帧会把上一条的出处
 * 挂到这一条头上,而它是一份真读数,下游看不出是别人的。
 */
export function useForwardedSource(messageId: string | null): ForwardedSource | null {
  const [, bump] = useState(0)

  useEffect(() => {
    if (!messageId) return
    if (forwardedSourceCache.has(messageId)) return
    const unsubscribe = subscribeForwardedSource(messageId, () => bump((n) => n + 1))
    requestForwardedSource(messageId)
    return unsubscribe
  }, [messageId])

  return messageId ? forwardedSourceCache.get(messageId) ?? null : null
}
