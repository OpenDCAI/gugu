// 余额 + 额度窗口的**唯一**订阅点。
//
// 以前侧栏、积分面板、额度页、低额横幅各写一套 useEffect + 各自的刷新节奏,同一时刻能读出
// 不一样的余额。现在只有这一个 store:一份数据、一套刷新、四个订阅者,读到的必然是同一份。
// 取不到就说取不到 —— 余额与窗口两条链路各自落地,一条挂了不会把另一条一起吞掉,也绝不
// 用 0 之类的假数字顶上。
import { useEffect, useState } from 'react'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { deriveSpendingPower, quotaSpendWindows, type SpendingPower } from '@gugu/core/billing'
import { isLifecycleCancellation } from '../authBoundedFetch'
import {
  subscribePrivateUserEventBus,
  unsubscribePrivateUserEventBus,
  type PrivateUserEventBusHandle,
} from '../realtimeChannel'
import { getCreditsBalance } from './balance'
import { getQuotaWindows, type QuotaWindows } from './quota'

export interface SpendingSnapshot {
  /** null = 还没取到或取不到,**不是** 0。 */
  balance: number | null
  balanceError: string | null
  /** 非 null 即已通过领域校验(政策自洽),下游可以直接推导,不必再防一手。 */
  windows: QuotaWindows | null
  /** 取不到,或服务端政策自相矛盾(推导出的短窗上限与回包不符)—— 都在这里响,不静默挑一个来信。 */
  windowsError: string | null
  /** 余额与窗口都在时才有。这是「还能花多少」的唯一来源。 */
  power: SpendingPower | null
  /** 计费版本:库的广播、回到前台各推进一次;用量页据此重取会员。 */
  activityRevision: number
}

const EMPTY: SpendingSnapshot = {
  balance: null,
  balanceError: null,
  windows: null,
  windowsError: null,
  power: null,
  activityRevision: 0,
}

type Listener = (snapshot: SpendingSnapshot) => void

const listeners = new Set<Listener>()
let snapshot: SpendingSnapshot = EMPTY
let activeUserId: string | null = null
let domListenersAttached = false
let billingEventHandle: PrivateUserEventBusHandle | null = null
// 四个订阅者同一帧挂载时不该打四遍同一个请求 —— 在途就跳过,拿同一份结果。
// 记的是「在途的那一发是谁的」而不是一个布尔:换人那一下,旧请求还没回来,新用户的请求
// 不能被这道去重挡掉 —— 挡掉的话旧回包因身份对不上被丢弃、新请求又没发出去,新用户要
// 干等到下一次外部事件才看得到余额。
let balanceInFlightFor: string | null = null
let windowsInFlightFor: string | null = null
// 每次刷新意图都推进版本。在途请求若跨过了一个新意图,它的回包已经可能落后于数据库广播,
// 必须丢掉并在 finally 补发一轮；否则去重会把事件吞掉,旧值能一直挂到下次外部事件。
let balanceRequestedRevision = 0
let windowsRequestedRevision = 0

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function publish(patch: Partial<SpendingSnapshot>): void {
  const next = { ...snapshot, ...patch }
  // 派生只在这里做一次,四个订阅者不可能各推各的。窗口在入库时已过领域校验,这里只差余额。
  next.power = next.balance === null || next.windows === null
    ? null
    : deriveSpendingPower(next.balance, next.windows)
  snapshot = next
  for (const listener of listeners) listener(snapshot)
}

async function refreshBalance(): Promise<void> {
  const userId = activeUserId
  if (!userId || balanceInFlightFor === userId) return
  const requestRevision = balanceRequestedRevision
  balanceInFlightFor = userId
  try {
    const balance = await getCreditsBalance()
    if (activeUserId !== userId || balanceRequestedRevision !== requestRevision) return
    publish({ balance, balanceError: null })
  } catch (error) {
    if (activeUserId !== userId || balanceRequestedRevision !== requestRevision) return
    // #2187 登出边界把在途请求取消掉,那不是「余额加载失败」,不该报错也不该清掉已有值。
    if (isLifecycleCancellation(error)) return
    publish({ balance: null, balanceError: message(error) })
  } finally {
    // 只清自己那一发:换人后新请求已经把标记改成新身份了,旧请求收尾时不能把它抹掉。
    if (balanceInFlightFor === userId) {
      balanceInFlightFor = null
      if (activeUserId === userId && balanceRequestedRevision !== requestRevision) void refreshBalance()
    }
  }
}

async function refreshWindows(): Promise<void> {
  const userId = activeUserId
  if (!userId || windowsInFlightFor === userId) return
  const requestRevision = windowsRequestedRevision
  windowsInFlightFor = userId
  try {
    const windows = await getQuotaWindows()
    if (activeUserId !== userId || windowsRequestedRevision !== requestRevision) return
    // 入库前先过一遍领域校验:政策自相矛盾(短窗上限与 周期额度 × 占比 对不上)的回包在这里
    // 就被挡住,免得下游每处各自防一手 —— 那正是「一处一坨」的来路。
    quotaSpendWindows(windows)
    publish({ windows, windowsError: null })
  } catch (error) {
    if (activeUserId !== userId || windowsRequestedRevision !== requestRevision) return
    if (isLifecycleCancellation(error)) return
    publish({ windows: null, windowsError: message(error) })
  } finally {
    if (windowsInFlightFor === userId) {
      windowsInFlightFor = null
      if (activeUserId === userId && windowsRequestedRevision !== requestRevision) void refreshWindows()
    }
  }
}

function refreshAll(): void {
  if (!officialServicesEnabled()) return
  balanceRequestedRevision += 1
  windowsRequestedRevision += 1
  void refreshBalance()
  void refreshWindows()
}

function refreshWhenVisible(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  // 回到前台:人可能刚在网页上开通或续费了会员。那只写会员表(bind_subscription → user_quota_periods)、
  // 不碰 user_credits,库的广播不会响 —— 推进计费版本,让读会员的那一处(用量页)也跟着重取(#5899)。
  if (activeUserId) publish({ activityRevision: snapshot.activityRevision + 1 })
  refreshAll()
}

function attachDomListeners(): void {
  if (!domListenersAttached && typeof window !== 'undefined') {
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    domListenersAttached = true
  }
}

function detachDomListeners(): void {
  if (domListenersAttached && typeof window !== 'undefined') {
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
    domListenersAttached = false
  }
}

function stopBillingEvents(): void {
  if (billingEventHandle === null) return
  unsubscribePrivateUserEventBus(billingEventHandle)
  billingEventHandle = null
}

function startBillingEvents(userId: string): void {
  stopBillingEvents()
  billingEventHandle = subscribePrivateUserEventBus(
    userId,
    'spending_power_changed',
    () => {
      if (activeUserId !== userId) return
      publish({ activityRevision: snapshot.activityRevision + 1 })
      refreshAll()
    },
    {
      // Reconnects also re-fetch once, closing any event gap while the socket was unavailable.
      onSubscribed: () => { if (activeUserId === userId) refreshAll() },
    },
  )
}

/** 换人(登入/登出/切号)→ 旧账清空,在途结果按 activeUserId 作废,绝不串到新用户名下。 */
function setActiveUser(userId: string | null): void {
  if (activeUserId === userId) return
  stopBillingEvents()
  activeUserId = userId
  snapshot = EMPTY
  publish({})
  if (userId) {
    startBillingEvents(userId)
    refreshAll()
  }
}

/** 手动催一次(充值回来、用户点刷新)。 */
export function refreshSpendingPower(): void {
  refreshAll()
}

export function useSpendingPower(user: { id: string } | null): SpendingSnapshot {
  const userId = officialServicesEnabled() ? user?.id ?? null : null
  const [local, setLocal] = useState<SpendingSnapshot>(() => activeUserId === userId ? snapshot : EMPTY)

  useEffect(() => {
    listeners.add(setLocal)
    attachDomListeners()
    setActiveUser(userId)
    // 已经有别的订阅者拉过数据时,新订阅者直接读现成的那一份,不重复打一遍网络。
    setLocal(snapshot)
    return () => {
      listeners.delete(setLocal)
      if (listeners.size === 0) {
        detachDomListeners()
        stopBillingEvents()
        activeUserId = null
        snapshot = EMPTY
      }
    }
  }, [userId])

  // setActiveUser 在 effect 中切全局身份；prop 已换人但 effect 尚未运行的首帧绝不能泄露上一人的账。
  return activeUserId === userId ? local : EMPTY
}
