import { dataClient } from './supabase'
import { ensureRealtimeAuth, onRealtimeAuthPushed } from './realtimeSessionManager'

export type ManagedRealtimeChannel = ReturnType<typeof dataClient.channel>
export type ManagedRealtimeChannelFactory = () => ManagedRealtimeChannel

type RealtimeChannelStatus =
  | 'authenticating'
  | 'subscribing'
  | 'subscribed'
  | 'reconnecting'
  | 'auth_error'
  | 'error'
  | 'closed'

export type RealtimeChannelRegistryEntry = {
  id: string
  label: string
  status: RealtimeChannelStatus
  lastError: string | null
  createdAt: number
  updatedAt: number
  receivedBroadcastCount: number
  lastBroadcastEvent: string | null
  lastBroadcastPayloadJson: string | null
  broadcastEventCounts: Record<string, number>
  lastBroadcastPayloadJsonByEvent: Record<string, string>
}

export type SubscribeAuthenticatedRealtimeChannelOptions = {
  shouldSubscribe?: () => boolean
  onSubscribed?: () => void
  onStatus?: (status: string, error?: Error) => void
  reconnectWhenIdle?: boolean
}

export type PrivateUserEventBusHandle = {
  userId: string
  eventName: string
  listenerId: number
}

export type PrivateUserEventBusOptions = {
  onSubscribed?: () => void
}

type InternalRealtimeChannelRegistryEntry = RealtimeChannelRegistryEntry & {
  channel: ManagedRealtimeChannel
  createChannel: ManagedRealtimeChannelFactory
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  subscribeWatchdogTimer: ReturnType<typeof setTimeout> | null
  shouldSubscribe: () => boolean
  onSubscribed: () => void
  onStatus: (status: string, error?: Error) => void
  reconnectWhenIdle: boolean
  debugEmitStatus: ((status: string, error?: Error) => void) | null
  // @@@stale-subscription-watchdog (#840) - last time this channel received a broadcast event.
  // The stale watchdog checks this; if too old while subscribed → force reconnect.
  lastEventAt: number
}

type PrivateUserEventBus = {
  userId: string
  channel: ManagedRealtimeChannel | null
  status: RealtimeChannelStatus
  listeners: Map<string, Map<number, (payload: unknown) => void>>
  onSubscribed: Map<number, () => void>
}

const registry = new Map<string, InternalRealtimeChannelRegistryEntry>()
const channelIds = new WeakMap<object, string>()
const privateUserEventBuses = new Map<string, PrivateUserEventBus>()
let nextChannelId = 1
let nextPrivateUserEventBusListenerId = 1

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]
const SUBSCRIBE_WATCHDOG_MS = 5000
// @@@stale-subscription-watchdog (#840) - if a subscribed channel hasn't received any broadcast
// event for this long, the backend (e.g. a stalled Logflare consumer) may have silently dropped
// delivery while keeping the WebSocket alive. Force a reconnect to re-establish event flow +
// the caller's onSubscribed callback fires → they re-fetch their snapshot.
const STALE_SUBSCRIPTION_MS = 2 * 60 * 1000 // 2 min — generous; presence/chat channels get regular events
const STALE_CHECK_INTERVAL_MS = 30 * 1000 // check every 30s
// @@@dev-realtime-payload-debug - Payload snapshots prove recovery in YATU but must not ship in production memory.
const SHOULD_RECORD_REALTIME_BROADCAST_DEBUG = import.meta.env.DEV

onRealtimeAuthPushed(() => {
  for (const [id, entry] of registry.entries()) {
    if (entry.status === 'error' || entry.status === 'auth_error') {
      retryNow(id)
    }
  }
})

// 网络回来:断网时 socket 自己发现不了(频道照样报 subscribed),要等一拍 25 s 的心跳没回音才断开重连 —— 手机断网 35 s
// 再恢复实测:频道要 12–16 s 才报错重订。网络回来就问 socket 一句:断网时发出的那拍心跳还没回音 = 线已死,Phoenix 当场
// 拆掉重连(sendHeartbeat 遇到未回的心跳就判超时);没有未回的就只是多发一拍心跳,活着的线不受影响。由事件驱动,❌ 定时器。
// 还没订上的频道(在等重连退避 / 卡在断网时发出的订阅上)一并当场重来,与上面登录态推送同一个口。
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void dataClient.realtime.sendHeartbeat()
    for (const [id, entry] of registry.entries()) {
      if (entry.status !== 'subscribed') retryNow(id)
    }
  })
}

// @@@stale-subscription-watchdog (#840) - scan all subscribed channels once. If a channel hasn't
// received any broadcast event for STALE_SUBSCRIPTION_MS, the backend (e.g. a stalled Logflare
// consumer) may have silently dropped event delivery while keeping the WebSocket alive. Force a
// reconnect to re-establish event flow + trigger onSubscribed (callers re-fetch their snapshot),
// preventing permanent stale 启动中/离线. `now` is injectable so tests drive it deterministically.
// Correct stall detection depends on lastEventAt being bumped on EVERY real event (see
// markRealtimeChannelEvent + the layer-owned wildcard listener) — otherwise every channel would
// look stale after STALE_SUBSCRIPTION_MS and churn-reconnect even while healthy.
export function runStaleSubscriptionCheck(now: number = Date.now()): void {
  for (const [id, entry] of registry.entries()) {
    if (entry.status !== 'subscribed') continue
    if (!entry.reconnectWhenIdle) continue
    if (!entry.shouldSubscribe()) continue
    if (entry.reconnectTimer) continue // already reconnecting
    const staleFor = now - entry.lastEventAt
    if (staleFor >= STALE_SUBSCRIPTION_MS) {
      console.warn(
        `[Realtime] ${entry.label} stale subscription (no events for ${Math.round(staleFor / 1000)}s), forcing reconnect`
      )
      setRegistryStatus(id, 'error', 'STALE_SUBSCRIPTION')
      scheduleReconnect(id)
    }
  }
}

const staleWatchdogTimer = setInterval(() => runStaleSubscriptionCheck(), STALE_CHECK_INTERVAL_MS)

function createPrivateUserEventBusChannel(userId: string): ManagedRealtimeChannel {
  return dataClient.channel(`gugu:user:${userId}:events`, {
    config: {
      private: true,
      broadcast: { self: false, ack: true },
    },
  })
}

export function subscribePrivateUserEventBus(
  userId: string,
  eventName: string,
  onEvent: (payload: unknown) => void,
  options: PrivateUserEventBusOptions = {},
): PrivateUserEventBusHandle {
  const bus = getOrCreatePrivateUserEventBus(userId)
  const listenerId = nextPrivateUserEventBusListenerId
  nextPrivateUserEventBusListenerId += 1
  const listeners = bus.listeners.get(eventName) ?? new Map<number, (payload: unknown) => void>()
  listeners.set(listenerId, onEvent)
  bus.listeners.set(eventName, listeners)
  if (options.onSubscribed) bus.onSubscribed.set(listenerId, options.onSubscribed)
  if (bus.status === 'subscribed') {
    queueMicrotask(() => {
      if (bus.onSubscribed.get(listenerId) === options.onSubscribed) options.onSubscribed?.()
    })
  }
  return { userId, eventName, listenerId }
}

export function unsubscribePrivateUserEventBus(handle: PrivateUserEventBusHandle): void {
  const bus = privateUserEventBuses.get(handle.userId)
  if (!bus) return
  const listeners = bus.listeners.get(handle.eventName)
  listeners?.delete(handle.listenerId)
  if (listeners?.size === 0) bus.listeners.delete(handle.eventName)
  bus.onSubscribed.delete(handle.listenerId)
  if (privateUserEventBusListenerCount(bus) > 0) return
  if (bus.channel) unsubscribeAuthenticatedRealtimeChannel(bus.channel)
  privateUserEventBuses.delete(handle.userId)
}

function getOrCreatePrivateUserEventBus(userId: string): PrivateUserEventBus {
  const existing = privateUserEventBuses.get(userId)
  if (existing) return existing
  const listeners = new Map<string, Map<number, (payload: unknown) => void>>()
  const onSubscribed = new Map<number, () => void>()
  const bus: PrivateUserEventBus = {
    userId,
    channel: null,
    status: 'authenticating',
    listeners,
    onSubscribed,
  }
  privateUserEventBuses.set(userId, bus)
  subscribeAuthenticatedRealtimeChannel(
    () => createPrivateUserEventBusPhysicalChannel(bus),
    `gugu:user:${userId}:events`,
    {
      shouldSubscribe: () => privateUserEventBuses.get(userId) === bus,
      reconnectWhenIdle: false,
      onStatus: (status) => {
        const current = privateUserEventBuses.get(userId)
        if (current !== bus) return
        if (status === 'SUBSCRIBED' || String(status).endsWith('.SUBSCRIBED')) return
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') current.status = 'error'
        if (status === 'CLOSED') current.status = 'closed'
      },
      onSubscribed: () => {
        const current = privateUserEventBuses.get(userId)
        if (current !== bus) return
        current.status = 'subscribed'
        current.onSubscribed.forEach((callback) => callback())
      },
    },
  )
  return bus
}

function createPrivateUserEventBusPhysicalChannel(bus: PrivateUserEventBus): ManagedRealtimeChannel {
  const { userId } = bus
  const channel = createPrivateUserEventBusChannel(userId)
  bus.channel = channel
  // @@@shared-user-event-bus - Supabase channels do not expose per-callback off; keep one wildcard physical channel and dispatch into removable app listeners.
  channel.on('broadcast', { event: '*' }, (payload: { event?: string; payload?: unknown }) => {
    const eventName = typeof payload?.event === 'string' ? payload.event : ''
    if (!eventName) return
    // Private user-bus listeners receive the event's inner payload, matching the old per-event channel callbacks.
    const eventPayload = Object.prototype.hasOwnProperty.call(payload, 'payload') ? payload.payload : payload
    if (SHOULD_RECORD_REALTIME_BROADCAST_DEBUG) {
      recordRealtimeChannelBroadcast(channel, eventName, eventPayload)
    }
    const current = privateUserEventBuses.get(userId)
    const eventListeners = current?.listeners.get(eventName)
    eventListeners?.forEach((listener) => listener(eventPayload))
  })
  return channel
}

function privateUserEventBusListenerCount(bus: PrivateUserEventBus): number {
  let count = 0
  bus.listeners.forEach((listeners) => {
    count += listeners.size
  })
  return count
}

export function subscribeAuthenticatedRealtimeChannel(
  channelOrFactory: ManagedRealtimeChannel | ManagedRealtimeChannelFactory,
  label: string,
  options: SubscribeAuthenticatedRealtimeChannelOptions = {},
): ManagedRealtimeChannel {
  const createChannel =
    typeof channelOrFactory === 'function' ? channelOrFactory : () => channelOrFactory
  const channel = createChannel()
  const shouldSubscribe = options.shouldSubscribe ?? (() => true)
  const onSubscribed = options.onSubscribed ?? (() => undefined)
  const onStatus = options.onStatus ?? (() => undefined)
  const id = ensureRegistryEntry(channel, label, createChannel, shouldSubscribe)
  const entry = registry.get(id)
  if (entry) {
    entry.createChannel = createChannel
    entry.shouldSubscribe = shouldSubscribe
    entry.onSubscribed = onSubscribed
    entry.onStatus = onStatus
    entry.reconnectWhenIdle = options.reconnectWhenIdle ?? true
  }
  subscribeRegistryEntry(id, 'authenticating')
  return channel
}

function subscribeRegistryEntry(id: string, pendingStatus: RealtimeChannelStatus): void {
  const entry = registry.get(id)
  if (!entry) return
  clearSubscribeWatchdog(id)
  setRegistryStatus(id, pendingStatus, entry.lastError)
  void ensureRealtimeAuth()
    .then(() => {
      const current = registry.get(id)
      if (!current || !current.shouldSubscribe() || current.status === 'closed') return
      setRegistryStatus(id, 'subscribing')
      const channel = current.channel
      startSubscribeWatchdog(id, channel)
      const handleSubscribeStatus = (status: string, error?: Error) => {
        const active = registry.get(id)
        if (!active || active.channel !== channel) return
        clearSubscribeWatchdog(id)
        active.onStatus(status, error)
        if (status === 'SUBSCRIBED' || String(status).endsWith('.SUBSCRIBED')) {
          clearReconnectTimer(id)
          const subscribed = registry.get(id)
          if (subscribed) {
            subscribed.reconnectAttempt = 0
            // @@@stale-subscription-watchdog (#840) - reset lastEventAt on (re)subscribe so the
            // stale watchdog gives the fresh subscription a full grace period.
            subscribed.lastEventAt = Date.now()
          }
          setRegistryStatus(id, 'subscribed')
          subscribed?.onSubscribed()
          return
        }
        if (error) {
          setRegistryStatus(id, 'error', errorMessage(error))
          console.error(`[Realtime] ${current.label} subscribe error`, error)
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          const latestStatus = registry.get(id)?.status
          if (status === 'CLOSED' && (latestStatus === 'reconnecting' || latestStatus === 'closed')) return
          setRegistryStatus(id, 'error', status)
          console.error(`[Realtime] ${current.label} subscribe status: ${status}`)
          scheduleReconnect(id)
        }
      }
      const subscribing = registry.get(id)
      if (subscribing) subscribing.debugEmitStatus = handleSubscribeStatus
      // @@@stale-subscription-watchdog (#840) - layer-owned wildcard listener bumps lastEventAt on
      // EVERY received broadcast (all channels, all builds), so runStaleSubscriptionCheck only
      // reconnects genuinely-stalled channels. Without this, lastEventAt was bumped only on
      // (re)subscribe in prod (recordRealtimeChannelBroadcast is DEV-only + event-bus-only) → every
      // channel looked stale after STALE_SUBSCRIPTION_MS and churn-reconnected even while healthy.
      // Coexists with callers' own specific-event listeners (Supabase fans out to all matching binds).
      channel.on('broadcast', { event: '*' }, () => markRealtimeChannelEvent(channel))
      channel.subscribe(handleSubscribeStatus)
    })
    .catch((error) => {
      setRegistryStatus(id, 'auth_error', errorMessage(error))
      console.error(`[Realtime] ${entry.label} auth error`, error)
      scheduleReconnect(id)
    })
}

/** 交回的 promise 在这条退完(或退失败)时落定 —— 同名 topic 要等它退完再订(realtime-js 在那之前会把正在退的交回来)。 */
export function unsubscribeAuthenticatedRealtimeChannel(channel: ManagedRealtimeChannel): Promise<void> {
  const id = channelIds.get(channel as object)
  if (id) {
    clearReconnectTimer(id)
    clearSubscribeWatchdog(id)
    setRegistryStatus(id, 'closed')
    const entry = registry.get(id)
    const channelToRemove = entry?.channel ?? channel
    try {
      // @@@owner-handle-cleanup - owners may hold the original channel while recovery has swapped in a fresh physical channel; cleanup must remove the registry's current channel.
      const result = dataClient.removeChannel(channelToRemove)
      return Promise.resolve(result)
        .then((status) => {
          if (status === 'ok') {
            registry.delete(id)
            return
          }
          markRemoveChannelFailure(id, entry?.label ?? id, status)
        })
        .catch((error) => {
          markRemoveChannelFailure(id, entry?.label ?? id, error)
        })
    } catch (error) {
      markRemoveChannelFailure(id, entry?.label ?? id, error)
    }
    return Promise.resolve()
  }
  return Promise.resolve(dataClient.removeChannel(channel)).then(() => undefined, () => undefined)
}

function markRemoveChannelFailure(id: string, label: string, error: unknown): void {
  console.error(`[Realtime] ${label} removeChannel failed`, error)
  setRegistryStatus(id, 'error', errorMessage(error))
}

export function listRealtimeChannelRegistry(): RealtimeChannelRegistryEntry[] {
  return Array.from(registry.values()).map(publicRealtimeChannelEntry)
}

function publicRealtimeChannelEntry(entry: InternalRealtimeChannelRegistryEntry): RealtimeChannelRegistryEntry {
  return {
    id: entry.id,
    label: entry.label,
    status: entry.status,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    receivedBroadcastCount: entry.receivedBroadcastCount,
    lastBroadcastEvent: entry.lastBroadcastEvent,
    lastBroadcastPayloadJson: entry.lastBroadcastPayloadJson,
    broadcastEventCounts: { ...entry.broadcastEventCounts },
    lastBroadcastPayloadJsonByEvent: { ...entry.lastBroadcastPayloadJsonByEvent },
  }
}

export function _resetRealtimeChannelRegistryForTesting(): void {
  for (const entry of registry.values()) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    if (entry.subscribeWatchdogTimer) clearTimeout(entry.subscribeWatchdogTimer)
  }
  registry.clear()
  privateUserEventBuses.clear()
  nextChannelId = 1
  nextPrivateUserEventBusListenerId = 1
  clearInterval(staleWatchdogTimer)
}

/**
 * @@@stale-subscription-watchdog (#840) - dev-only hook for YATU. Forces a subscribed channel's
 * lastEventAt to now - STALE_SUBSCRIPTION_MS - 1, so the next watchdog tick (≤30s) detects it
 * as stale and triggers reconnect. This lets Elisa/guye verify the stale watchdog without
 * actually stopping backend event delivery (which would be hard to control in a test).
 *
 * Usage (browser console or YATU script):
 *   __guguSimulateStaleSubscription('gugu:user:...:events')
 *
 * Returns true if the channel was found and staled, false if not found or not subscribed.
 */
export function _simulateStaleSubscriptionForTesting(labelOrId: string): boolean {
  const entry = registry.get(labelOrId)
    ?? Array.from(registry.values()).find((e) => e.label === labelOrId)
  if (!entry || entry.status !== 'subscribed') return false
  entry.lastEventAt = Date.now() - STALE_SUBSCRIPTION_MS - 1
  console.warn(`[Realtime] DEV: simulated stale subscription for ${entry.label}`)
  return true
}

// @@@stale-subscription-watchdog (#840) - runtime-guarded window exposure so CDP/YATU scripts can call
// _simulateStaleSubscriptionForTesting from page.evaluate. Uses a runtime check (not import.meta.env.DEV,
// which is stripped by Vite in production builds) so the hook works in packaged apps when explicitly enabled.
if (import.meta.env.DEV || localStorage.getItem('__gugu_test_hooks') === '1') {
  (globalThis as Record<string, unknown>).__guguSimulateStaleSubscription = _simulateStaleSubscriptionForTesting
}

function ensureRegistryEntry(
  channel: ManagedRealtimeChannel,
  label: string,
  createChannel: ManagedRealtimeChannelFactory,
  shouldSubscribe: () => boolean,
  onSubscribed: () => void = () => undefined,
  onStatus: (status: string, error?: Error) => void = () => undefined,
): string {
  const existing = channelIds.get(channel as object)
  if (existing) return existing
  const id = `rt-${nextChannelId}`
  nextChannelId += 1
  const now = Date.now()
  channelIds.set(channel as object, id)
  registry.set(id, {
    id,
    label,
    status: 'authenticating',
    lastError: null,
    createdAt: now,
    updatedAt: now,
    channel,
    createChannel,
    reconnectAttempt: 0,
    reconnectTimer: null,
    subscribeWatchdogTimer: null,
    shouldSubscribe,
    onSubscribed,
    onStatus,
    reconnectWhenIdle: true,
    debugEmitStatus: null,
    lastEventAt: now,
    receivedBroadcastCount: 0,
    lastBroadcastEvent: null,
    lastBroadcastPayloadJson: null,
    broadcastEventCounts: {},
    lastBroadcastPayloadJsonByEvent: {},
  })
  return id
}

// @@@stale-subscription-watchdog (#840) - bump the channel's lastEventAt on every received broadcast.
// Cheap (no payload work) so it runs in ALL builds for ALL channels via the layer-owned wildcard
// listener — this is what makes runStaleSubscriptionCheck a real stall detector rather than a blind
// every-2min reconnect. Unknown channels (no registry entry) are ignored.
function markRealtimeChannelEvent(channel: ManagedRealtimeChannel): void {
  const id = channelIds.get(channel as object)
  if (!id) return
  const entry = registry.get(id)
  if (entry) entry.lastEventAt = Date.now()
}

function recordRealtimeChannelBroadcast(
  channel: ManagedRealtimeChannel,
  eventName: string,
  payload: unknown,
): void {
  const id = channelIds.get(channel as object)
  if (!id) return
  const entry = registry.get(id)
  if (!entry) return
  // @@@stale-subscription-watchdog (#840) - update lastEventAt on every received broadcast.
  entry.lastEventAt = Date.now()
  const payloadJson = stringifyRealtimePayloadForDebug(payload)
  registry.set(id, {
    ...entry,
    receivedBroadcastCount: entry.receivedBroadcastCount + 1,
    lastBroadcastEvent: eventName,
    lastBroadcastPayloadJson: payloadJson,
    broadcastEventCounts: { ...entry.broadcastEventCounts, [eventName]: (entry.broadcastEventCounts[eventName] ?? 0) + 1 },
    lastBroadcastPayloadJsonByEvent: { ...entry.lastBroadcastPayloadJsonByEvent, [eventName]: payloadJson },
    updatedAt: Date.now(),
  })
}

function stringifyRealtimePayloadForDebug(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? 'null'
  } catch (error) {
    return `[unserializable:${errorMessage(error)}]`
  }
}

export function debugEmitRealtimeChannelStatus(
  idOrLabel: string,
  status: string,
  errorText?: string,
): RealtimeChannelRegistryEntry {
  const entry = registry.get(idOrLabel)
    ?? Array.from(registry.values()).find((candidate) => candidate.label === idOrLabel)
  if (!entry) throw new Error(`Realtime channel not found: ${idOrLabel}`)
  if (status === 'auth_error') {
    // @@@debug-auth-error-injection - Supabase does not emit this subscribe status; real auth failures enter the auth boundary catch.
    setRegistryStatus(entry.id, 'auth_error', errorText ?? 'auth_error')
    scheduleReconnect(entry.id)
    const updated = registry.get(entry.id)
    if (!updated) throw new Error(`Realtime channel disappeared after debug status: ${entry.label}`)
    return publicRealtimeChannelEntry(updated)
  }
  if (!entry.debugEmitStatus) throw new Error(`Realtime channel has no active subscribe handler: ${entry.label}`)
  entry.debugEmitStatus(status, errorText ? new Error(errorText) : undefined)
  const updated = registry.get(entry.id)
  if (!updated) throw new Error(`Realtime channel disappeared after debug status: ${entry.label}`)
  return publicRealtimeChannelEntry(updated)
}

function setRegistryStatus(
  id: string,
  status: RealtimeChannelStatus,
  lastError: string | null = null,
): void {
  const entry = registry.get(id)
  if (!entry) return
  registry.set(id, {
    ...entry,
    status,
    lastError,
    updatedAt: Date.now(),
  })
}

function scheduleReconnect(id: string): void {
  const entry = registry.get(id)
  if (!entry || entry.reconnectTimer || !entry.shouldSubscribe()) return
  const delay = RECONNECT_DELAYS_MS[Math.min(entry.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  entry.reconnectAttempt += 1
  entry.reconnectTimer = setTimeout(() => {
    retryNow(id)
  }, delay)
}

function clearReconnectTimer(id: string): void {
  const entry = registry.get(id)
  if (!entry?.reconnectTimer) return
  clearTimeout(entry.reconnectTimer)
  entry.reconnectTimer = null
}

function startSubscribeWatchdog(id: string, channel: ManagedRealtimeChannel): void {
  clearSubscribeWatchdog(id)
  const timer = setTimeout(() => {
    const current = registry.get(id)
    if (!current || current.channel !== channel || current.status !== 'subscribing' || !current.shouldSubscribe()) return
    registry.set(id, { ...current, subscribeWatchdogTimer: null })
    setRegistryStatus(id, 'error', 'SUBSCRIBE_TIMEOUT')
    console.error(`[Realtime] ${current.label} subscribe status: SUBSCRIBE_TIMEOUT`)
    scheduleReconnect(id)
  }, SUBSCRIBE_WATCHDOG_MS)
  const current = registry.get(id)
  if (!current || current.channel !== channel) {
    clearTimeout(timer)
    return
  }
  registry.set(id, { ...current, subscribeWatchdogTimer: timer })
}

function clearSubscribeWatchdog(id: string): void {
  const entry = registry.get(id)
  if (!entry?.subscribeWatchdogTimer) return
  clearTimeout(entry.subscribeWatchdogTimer)
  entry.subscribeWatchdogTimer = null
}

function retryNow(id: string): void {
  const current = registry.get(id)
  if (!current) return
  clearReconnectTimer(id)
  clearSubscribeWatchdog(id)
  // @@@closed-is-terminal - unsubscribe sets 'closed' synchronously before its async removeChannel
  if (current.status === 'closed' || !current.shouldSubscribe()) return
  setRegistryStatus(id, 'reconnecting', current.lastError)
  void current.channel
    .unsubscribe()
    .catch((error) => {
      console.error(`[Realtime] ${current.label} retry unsubscribe error`, error)
    })
    .finally(() => {
      const latest = registry.get(id)
      if (!latest || latest.status === 'closed' || !latest.shouldSubscribe()) return
      const channel = latest.createChannel()
      channelIds.set(channel as object, id)
      registry.set(id, {
        ...latest,
        channel,
        debugEmitStatus: null,
      })
      subscribeRegistryEntry(id, 'reconnecting')
    })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
