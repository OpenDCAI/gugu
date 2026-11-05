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
import type { CreditAmount } from '@gugu/core/billing/creditAmount'
import type { QuotaWindows } from './quota'
import { membershipProjection, type Membership } from './membership'
import { readCreditV2Account } from './v2/runtime'

export interface SpendingSnapshot {
  membership: Membership | null
  creditVersion: string | null
  /** null = 还没取到或取不到,**不是** 0。 */
  balance: CreditAmount | null
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
  membership: null,
  creditVersion: null,
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
// A refresh publishes one account/version tuple; it never exposes a new balance with old quota.
let accountInFlight: { userId: string } | null = null
let accountRequestedRevision = 0

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function publish(patch: Partial<SpendingSnapshot>): void {
  const next = { ...snapshot, ...patch }
  next.power = next.balance === null || next.windows === null
    ? null
    : deriveSpendingPower(next.balance, next.windows)
  snapshot = next
  for (const listener of listeners) listener(snapshot)
}

async function refreshAccount(): Promise<void> {
  const userId = activeUserId
  if (!userId || accountInFlight?.userId === userId) return
  const requestRevision = accountRequestedRevision
  const request = { userId }
  accountInFlight = request
  try {
    const account = await readCreditV2Account()
    if (activeUserId !== userId || accountRequestedRevision !== requestRevision) return
    if (account.windows) quotaSpendWindows(account.windows)
    const membership = account.plan ? membershipProjection(account.plan) : null
    publish({ balance: account.balance, windows: account.windows, membership,
      creditVersion: JSON.stringify(account.meta),
      balanceError: account.balanceError === null ? null : message(account.balanceError),
      windowsError: account.windowsError === null ? null : message(account.windowsError) })
  } catch (error) {
    if (activeUserId !== userId || accountRequestedRevision !== requestRevision) return
    if (isLifecycleCancellation(error)) return
    publish({ balance: null, windows: null, membership: null, creditVersion: null,
      balanceError: message(error), windowsError: message(error) })
  } finally {
    if (accountInFlight === request) {
      accountInFlight = null
      if (activeUserId === userId && accountRequestedRevision !== requestRevision) void refreshAccount()
    }
  }
}

function refreshAll(): void {
  if (!officialServicesEnabled()) return
  accountRequestedRevision += 1
  void refreshAccount()
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
  accountInFlight = null
  accountRequestedRevision += 1
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
        accountInFlight = null
        accountRequestedRevision += 1
        activeUserId = null
        snapshot = EMPTY
      }
    }
  }, [userId])

  // setActiveUser 在 effect 中切全局身份；prop 已换人但 effect 尚未运行的首帧绝不能泄露上一人的账。
  return activeUserId === userId ? local : EMPTY
}
