import { useCallback, useRef, useState } from 'react'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'

/**
 * @@@snapshot-epoch - invalidates async snapshots around destructive message mutations.
 * 每条线一个号:读发出时记下 `epochOf`,落地时号变了(期间有删改)就丢掉这份快照;`bump` 让在途的读全部作废。
 */
export function useMessageSnapshotEpochs() {
  const epochsRef = useRef(new Map<string, number>())
  const epochOf = useCallback((chatId: string): number => epochsRef.current.get(chatId) ?? 0, [])
  const bump = useCallback((chatId: string): number => {
    const next = epochOf(chatId) + 1
    epochsRef.current.set(chatId, next)
    return next
  }, [epochOf])
  return { epochOf, bump }
}

/**
 * #7199 每条线最近一次读的失败(读成了就清),给消息列表说「读不到 + 重试」用(❌ 空列表落成首次对话欢迎页)。
 * - 按会话记:一条线迟到的失败 ❌ 盖掉另一条线此刻的失败;
 * - 同一条线上打开时的那一读与「重试」共用一个号,只有最新发出的那次的结局能写 / 清 —— 较早发出、较晚失败的那次
 *   ❌ 盖掉较新那次的成功;
 * - 生命周期取消(登出、换账号)不是读失败。
 */
export function useMessageReadFailures() {
  const [failures, setFailures] = useState<Readonly<Record<string, Error>>>({})
  const latestRef = useRef(new Map<string, number>())
  const settle = useCallback((chatId: string, read: number, error: unknown) => {
    if (latestRef.current.get(chatId) !== read) return
    if (error !== null && isLifecycleCancellation(error)) return
    setFailures((prev) => {
      if (error !== null) return { ...prev, [chatId]: error instanceof Error ? error : new Error(String(error)) }
      if (!(chatId in prev)) return prev
      const { [chatId]: _cleared, ...rest } = prev
      return rest
    })
  }, [])
  /** 这一读算作这条线最新的一次;它落地时按结局写 / 清读失败,结果原样交回(失败照旧抛出)。 */
  const track = useCallback(<T>(chatId: string, read: Promise<T>): Promise<T> => {
    const id = (latestRef.current.get(chatId) ?? 0) + 1
    latestRef.current.set(chatId, id)
    return read.then(
      (value) => { settle(chatId, id, null); return value },
      (error: unknown) => { settle(chatId, id, error); throw error },
    )
  }, [settle])
  /**
   * 这条线别的读(重连补洞、往新翻、回到最新)成了、窗口已到最新:读失败不再成立,清掉;也让比它早发出、还在路上的
   * 那一读失去资格(❌ 它晚到的失败又把横幅挂回来)。
   */
  const noteFreshRead = useCallback((chatId: string) => {
    latestRef.current.set(chatId, (latestRef.current.get(chatId) ?? 0) + 1)
    setFailures((prev) => {
      if (!(chatId in prev)) return prev
      const { [chatId]: _cleared, ...rest } = prev
      return rest
    })
  }, [])
  const failureOf = useCallback((chatId: string | null): Error | null => (chatId ? failures[chatId] ?? null : null), [failures])
  return { track, noteFreshRead, failureOf }
}
