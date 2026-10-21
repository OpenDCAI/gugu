import { useCallback, useRef, useSyncExternalStore } from 'react'
import { rendererLogger } from '../lib/log'
import {
  readSessionpageSessionStartupFailureBridge,
  type SessionpageSessionStartupFailure,
  type SessionpageSessionStartupFailureBridge,
} from '../lib/sessionpageSessionStartupFailureBridge'

// #4602 —— 当前 DM 映射到的会话页 conversation 若停在「会话启动失败」,把那条失败交给聊天面显形。
//
// 没有自有的「关于某个主体的读数」:值在渲染期由**当前** conversationId 直接从账本快照里挑出来
// (#3922 那一族要防的是「副作用里追主体、切换那一帧交出上一个主体的答案」;这里换主体立刻换答案)。
// 唯一的自有状态是「桥装上了没有」—— 任务 bundle 是 14MB 的 module,它的入口接线可能晚于本 hook 挂载;
// 桥不在就隔一会儿再看,装上即订阅。等待有上限:超过 BRIDGE_ATTACH_MAX_MS 还没有桥,说明任务帧根本没起来
// (EmdashSessionFrame 自己那一侧会显示加载失败),本 hook 停止轮询并经 rendererLogger 记一条 —— ❌ 不无限轮询,也
// ❌ 不把「桥缺席」伪装成「没有失败」之外的任何状态:没有桥就读不到账本,这一点要留下痕迹。
// web / Capacitor 没有任务帧 ⇒ 永远没有桥,但那些壳里 conversationId 也永远是 null(投影读不到会话页上下文),
// 不会开始轮询。

const BRIDGE_ATTACH_POLL_MS = 500
const BRIDGE_ATTACH_MAX_MS = 30_000
const log = rendererLogger('chat/sessionpage-session-startup-failure')
const EMPTY: readonly SessionpageSessionStartupFailure[] = []

export interface SessionpageSessionStartupFailureView {
  /** 给人看的那一句(任务页那一侧按原因表说的,与任务页内容区同一句);原文 ❌ 上屏。 */
  text: string
  /** 重试能不能改变它;不能的(换模型 / 开会员)出口是「打开任务」。 */
  retryable: boolean
  /** 已按下重试、hydrate 正在飞:禁用重试出口并如实写「重试中」。 */
  retrying: boolean
  retry: () => void
}

export function useSessionpageSessionStartupFailure(
  sessionId: string | null,
): SessionpageSessionStartupFailureView | null {
  const bridgeRef = useRef<SessionpageSessionStartupFailureBridge | undefined>(undefined)

  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!sessionId) return () => {}
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let waited = 0
    const attach = () => {
      if (disposed) return
      const bridge = readSessionpageSessionStartupFailureBridge()
      if (!bridge) {
        waited += BRIDGE_ATTACH_POLL_MS
        if (waited >= BRIDGE_ATTACH_MAX_MS) {
          log.error(
            { sessionId, waitedMs: waited },
            'session startup failure bridge never attached — the session frame did not finish its entry wiring; startup failures are unobservable from this DM',
          )
          return
        }
        timer = setTimeout(attach, BRIDGE_ATTACH_POLL_MS)
        return
      }
      bridgeRef.current = bridge
      unsubscribe = bridge.subscribe(onStoreChange)
      // 桥刚装上这一刻快照可能已经有东西了,通知一次让渲染期重新取值。
      onStoreChange()
    }
    attach()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
    }
  }, [sessionId])

  const getSnapshot = useCallback(
    () => bridgeRef.current?.snapshot() ?? EMPTY,
    [],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const entry = sessionId ? snapshot.find((row) => row.sessionId === sessionId) : undefined
  const retry = useCallback(() => {
    // 返回 false = 账本里已没有这条(标签页刚关掉 / 别处已重试):界面随快照收敛,不必再做什么。
    if (sessionId) bridgeRef.current?.retry(sessionId)
  }, [sessionId])

  const bridge = bridgeRef.current
  return entry && bridge ? { ...bridge.describe(entry.message), retrying: entry.retrying, retry } : null
}
