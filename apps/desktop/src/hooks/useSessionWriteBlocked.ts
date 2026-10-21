import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sessionCoordinator } from '../lib/sessionCoordinator'
import { isSessionPastExpiry, nextWriteBlockedState, type WriteBlockedMemo } from '../lib/sessionExpiryModel'

// 到期不会产生任何 re-render 来救 —— 令牌是静静过期的。所以必须有一次主动重算:
// 定时器给出上界,窗口重新聚焦(合盖后醒来,正是 owner 那台机器的情形)给出即时性。
const RECHECK_INTERVAL_MS = 10_000

// @@@4395 判定本身是纯函数(sessionExpiryModel 的 nextWriteBlockedState),本 hook 只负责
// 「什么时候去问一次」以及把记忆存在 ref 里。安静窗口为什么存在、为什么从「有机会重试」起算,
// 理由写在那个纯函数旁边。
export { SESSION_RECOVERY_QUIET_MS } from '../lib/sessionExpiryModel'

/**
 * @@@3898 @@@4395 「此刻写操作会失败吗,而且已经不像是马上能自己好的了」。
 * 真相来自 SessionCoordinator 的快照(会话的单一权威),本 hook 只做派生 —— ❌ 不另起一份会话状态。
 */
export function useSessionWriteBlocked(): boolean {
  const snapshot = useSyncExternalStore(
    sessionCoordinator.subscribe,
    sessionCoordinator.getSnapshot,
    sessionCoordinator.getSnapshot,
  )
  const [blocked, setBlocked] = useState(false)
  // ref 而非 state:重试期间 coordinator 每次 degrade 都会换快照;若记忆跟着 effect 重建,
  // 安静窗口就会被无限重置、永远不出声。
  const memo = useRef<WriteBlockedMemo>({ strugglingSince: null, lastSeenAt: Date.now() })

  useEffect(() => {
    const evaluate = () => {
      const now = Date.now()
      const pastExpiry = Boolean(snapshot.user) && isSessionPastExpiry(snapshot.session, now)
      const next = nextWriteBlockedState(memo.current, pastExpiry, now)
      memo.current = next.memo
      setBlocked(next.blocked)
    }
    // 网络回来 = 一个全新的重试机会,安静窗口重新计时。
    const freshChance = () => {
      memo.current = { strugglingSince: null, lastSeenAt: Date.now() }
      evaluate()
    }
    evaluate()
    const timer = setInterval(evaluate, RECHECK_INTERVAL_MS)
    window.addEventListener('focus', evaluate)
    window.addEventListener('online', freshChance)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', evaluate)
      window.removeEventListener('online', freshChance)
    }
  }, [snapshot])

  return blocked
}
