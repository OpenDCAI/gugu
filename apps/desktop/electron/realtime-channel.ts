export type ElectronManagedRealtimeChannel = {
  unsubscribe?: () => unknown | Promise<unknown>
  subscribe: (callback: (status: string, err?: Error) => void) => ElectronManagedRealtimeChannel
}

/** 一条订着的私有频道上能发广播的那一面。 */
export type BroadcastChannel = {
  send: (message: { type: 'broadcast'; event: string; payload: unknown }) => Promise<unknown>
}

/**
 * 发一条广播,发不出去就失败。realtime-js 的 `send` 从不 reject:被拒(超过单条上限、限流)或等不到确认时只回
 * 'error' / 'timed out' —— 不在这里变成失败,调用方就当它发出去了,丢掉的那一帧悄无声息(远程会话页按 seq 等它,一直等)。
 */
export async function sendBroadcast(channel: BroadcastChannel, event: string, payload: unknown): Promise<void> {
  const result = await channel.send({ type: 'broadcast', event, payload })
  if (result !== 'ok') throw new Error(`broadcast ${event} not delivered: ${String(result)}`)
}

export type ElectronRealtimeClient = {
  realtime: {
    setAuth: () => unknown | Promise<unknown>
  }
  removeChannel: (channel: ElectronManagedRealtimeChannel) => unknown
}

export type ElectronRealtimeChannelStatus =
  | 'authenticating'
  | 'subscribing'
  | 'subscribed'
  | 'reconnecting'
  | 'auth_error'
  | 'error'
  | 'closed'

export type ElectronRealtimeChannelRegistryEntry = {
  id: string
  label: string
  status: ElectronRealtimeChannelStatus
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type SubscribeElectronRealtimeChannelOptions = {
  label: string
  createChannel?: () => ElectronManagedRealtimeChannel
  onStatus?: (status: string, err?: Error) => void
  /** Synchronous loss of continuity, before authentication/replacement/removal can await. */
  onUnavailable?: () => void
  unsubscribeOnStatus?: (status: string, err?: Error) => boolean
  /** A factory defaults to managed retry unless the caller requests one-shot removal. */
  reconnectOnStatus?: (status: string, err?: Error) => boolean
}

type InternalElectronRealtimeChannelRegistryEntry = ElectronRealtimeChannelRegistryEntry & {
    channel: ElectronManagedRealtimeChannel
    client: ElectronRealtimeClient
    createChannel: (() => ElectronManagedRealtimeChannel) | null
    reconnectAttempt: number
    reconnectTimer: ReturnType<typeof setTimeout> | null
    active: boolean
    attempt: number
    subscribedOnce: boolean
    onStatus: (status: string, err?: Error) => void
    onUnavailable: (() => void) | null
    reconnectOnStatus: ((status: string, err?: Error) => boolean) | null
    unsubscribeOnStatus: (status: string, err?: Error) => boolean
  }

const registry = new Map<string, InternalElectronRealtimeChannelRegistryEntry>()
const reconnectFlights = new Map<string, Promise<void>>()
const debugStatusHandlers = new Map<string, (status: string, err?: Error) => void>()
let nextChannelId = 1
let paused = 0

/** Resume authentication owns this barrier; stale tickets must not auto-rejoin. */
export function pauseElectronRealtimeChannels(): () => void {
  paused++
  for (const [id, entry] of registry) { withdrawContinuity(entry); clearReconnectTimer(id) }
  let released = false
  return () => { if (!released) { released = true; paused-- } }
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]

export async function subscribeAuthenticatedElectronRealtimeChannel(
  client: ElectronRealtimeClient,
  channel: ElectronManagedRealtimeChannel,
  options: SubscribeElectronRealtimeChannelOptions
): Promise<() => Promise<void>> {
  const id = `ert-${nextChannelId}`
  nextChannelId += 1
  const now = Date.now()
  registry.set(id, {
    id,
    label: options.label,
    status: 'authenticating',
    lastError: null,
    createdAt: now,
    updatedAt: now,
    channel,
    client,
    createChannel: options.createChannel ?? null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    active: true,
    attempt: 0,
    subscribedOnce: false,
    onStatus: options.onStatus ?? (() => undefined),
    onUnavailable: options.onUnavailable ?? null,
    reconnectOnStatus: options.reconnectOnStatus ?? null,
    unsubscribeOnStatus: options.unsubscribeOnStatus ?? (() => false)
  })

  await subscribeRegistryEntry(id, false)

  // 交回的 promise 在这条退完时落定:同名 topic 要等它退完再订(realtime-js 在那之前会把正在退的那条交回来)。
  return () => {
    const entry = registry.get(id)
    if (!entry) return Promise.resolve()
    withdrawContinuity(entry)
    entry.active = false
    clearReconnectTimer(id)
    debugStatusHandlers.delete(id)
    registry.delete(id)
    return safeRemoveChannel(entry.client, entry.channel, entry.label)
  }
}

export function listElectronRealtimeChannelRegistry(): ElectronRealtimeChannelRegistryEntry[] {
  return Array.from(registry.values()).map((entry) => ({
    id: entry.id,
    label: entry.label,
    status: entry.status,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }))
}

/** After an explicit host resume, replace stale physical subscriptions now,
 * without waiting for CHANNEL_ERROR or the normal reconnect backoff. */
export async function reconnectElectronRealtimeChannels(): Promise<void> {
  await Promise.all([...registry.keys()].map(id => retryNow(id)))
}

// TEST-ONLY, env-gated (GUGU_DEVICE_RUNTIME_ACCOUNT_SWITCH_TEST_HOOKS=1). The flag is fixed at
// Electron process startup, so this module-level assignment is stable for the full runtime.
// Unset in production -> NOT assigned -> no product surface / no runtime probe.
if (process.env.GUGU_DEVICE_RUNTIME_ACCOUNT_SWITCH_TEST_HOOKS === '1') {
  const testGlobal = globalThis as typeof globalThis & {
    __guguDeviceRuntimeAccountSwitchProbe?: {
      snapshot: () => { realtimeChannels: ElectronRealtimeChannelRegistryEntry[] }
    }
  }
  testGlobal.__guguDeviceRuntimeAccountSwitchProbe = {
    snapshot: () => ({ realtimeChannels: listElectronRealtimeChannelRegistry() }),
  }
}

export function _resetElectronRealtimeChannelRegistryForTesting(): void {
  paused = 0
  for (const entry of registry.values()) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
  }
  registry.clear()
  reconnectFlights.clear()
  debugStatusHandlers.clear()
  nextChannelId = 1
}

export function debugEmitElectronRealtimeChannelStatus(
  idOrLabel: string,
  status: string,
  errorText?: string
): ElectronRealtimeChannelRegistryEntry {
  const entry = registry.get(idOrLabel) ?? Array.from(registry.values()).find((item) => item.label === idOrLabel)
  if (!entry) throw new Error(`Electron Realtime channel not found: ${idOrLabel}`)
  const handler = debugStatusHandlers.get(entry.id)
  if (!handler) throw new Error(`Electron Realtime channel has no active subscribe handler: ${entry.label}`)
  handler(status, errorText ? new Error(errorText) : undefined)
  const updated = registry.get(entry.id)
  if (!updated) throw new Error(`Electron Realtime channel disappeared after debug status: ${entry.label}`)
  return registryEntry(updated)
}

async function subscribeRegistryEntry(id: string, reconnecting: boolean): Promise<void> {
  const entry = registry.get(id)
  if (!entry?.active) return
  if (paused) { setRegistryStatus(id, 'reconnecting'); return }
  let subscribed = false
  let unsubscribeRequested = false
  const removeCurrentChannel = () => {
    const current = registry.get(id)
    if (!current?.active) return
    current.active = false
    safeRemoveChannel(current.client, current.channel, current.label)
    debugStatusHandlers.delete(id)
    registry.delete(id)
  }

  const attempt = ++entry.attempt
  setRegistryStatus(id, reconnecting ? 'reconnecting' : 'authenticating')
  entry.onUnavailable?.()
  try {
    // 认证由账号客户端现取;频道重连不能拿创建时的旧令牌覆盖共享连接。
    await entry.client.realtime.setAuth()
  } catch (error) {
    const latest = registry.get(id)
    if (!latest?.active) return
    if (latest.attempt !== attempt) { if (!paused) scheduleReconnect(id); return }
    setRegistryStatus(id, 'auth_error', errorMessage(error))
    scheduleReconnect(id)
    return
  }
  const current = registry.get(id)
  if (!current?.active) return
  if (paused || current.attempt !== attempt) { if (!paused) scheduleReconnect(id); return }
  setRegistryStatus(id, 'subscribing')
  const subscribedChannel = current.channel
  const handleSubscribeStatus = (status: string, err?: Error) => {
    const latest = registry.get(id)
    // A replaced physical channel can report CLOSED during (or even after) its intentional
    // unsubscribe. It no longer owns this registry entry, so its callback must not schedule
    // another reconnect for the fresh channel.
    if (!latest?.active || paused || latest.attempt !== attempt || latest.channel !== subscribedChannel) return
    const name = statusName(status)
    const joined = !err && (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED'))
    if (!joined && latest.onUnavailable) withdrawContinuity(latest)
    latest.onStatus(status, err)
    if (joined) {
      clearReconnectTimer(id)
      latest.subscribedOnce = true
      latest.reconnectAttempt = 0
      setRegistryStatus(id, 'subscribed')
      return
    }
    // One-shot subscriptions may deliberately hand initial failures back to their owner.
    // Managed persistent channels must retry even when their very first join failed.
    const shouldUnsubscribe = latest.unsubscribeOnStatus(status, err)
    const shouldReconnect = latest.reconnectOnStatus?.(status, err) ?? (!!latest.createChannel && !shouldUnsubscribe)
    // Legacy callers without a continuity observer may rely on SDK rejoin callbacks.
    // Retire those attempts only when the manager owns replacement/removal; policy
    // observers always retire immediately and require a fresh authenticated attempt.
    if (!latest.onUnavailable && (shouldReconnect || shouldUnsubscribe)) withdrawContinuity(latest)
    if (shouldReconnect && (latest.subscribedOnce || !shouldUnsubscribe)) {
      setRegistryStatus(id, name === 'CLOSED' ? 'closed' : 'error', name)
      scheduleReconnect(id)
      return
    }
    if (!shouldUnsubscribe) return
    if (subscribed) {
      removeCurrentChannel()
      return
    }
    unsubscribeRequested = true
  }
  debugStatusHandlers.set(id, handleSubscribeStatus)
  subscribedChannel.subscribe(handleSubscribeStatus)
  subscribed = true
  if (unsubscribeRequested) removeCurrentChannel()
}

function setRegistryStatus(
  id: string,
  status: ElectronRealtimeChannelStatus,
  lastError: string | null = null
): void {
  const entry = registry.get(id)
  if (!entry) return
  registry.set(id, {
    ...entry,
    status,
    lastError,
    updatedAt: Date.now()
  })
}

function scheduleReconnect(id: string): void {
  const entry = registry.get(id)
  if (paused || !entry || entry.reconnectTimer || !entry.createChannel) return
  const delay = RECONNECT_DELAYS_MS[Math.min(entry.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  entry.reconnectAttempt += 1
  entry.reconnectTimer = setTimeout(() => {
    void retryNow(id)
  }, delay)
}

function clearReconnectTimer(id: string): void {
  const entry = registry.get(id)
  if (!entry?.reconnectTimer) return
  clearTimeout(entry.reconnectTimer)
  entry.reconnectTimer = null
}

function retryNow(id: string): Promise<void> {
  if (paused) return Promise.resolve()
  const existing = reconnectFlights.get(id)
  if (existing) return existing
  const flight = replacePhysicalChannel(id).finally(() => {
    if (reconnectFlights.get(id) === flight) reconnectFlights.delete(id)
  })
  reconnectFlights.set(id, flight)
  return flight
}

async function replacePhysicalChannel(id: string): Promise<void> {
  const entry = registry.get(id)
  if (!entry?.active || !entry.createChannel) return
  clearReconnectTimer(id)
  withdrawContinuity(entry)
  const attempt = entry.attempt
  setRegistryStatus(id, 'reconnecting', entry.lastError)
  if (entry.channel.unsubscribe) {
    try {
      await entry.channel.unsubscribe()
    } catch {
      // Supabase retry should not get stuck because local channel leave failed.
    }
  }
  const fresh = registry.get(id)
  if (!fresh?.active) return
  if (paused || fresh.attempt !== attempt) { if (!paused) scheduleReconnect(id); return }
  const nextChannel = entry.createChannel()
  fresh.channel = nextChannel
  await subscribeRegistryEntry(id, true)
}

/** Withdrawn continuity cannot be revived by callbacks from the retired attempt. */
function withdrawContinuity(entry: InternalElectronRealtimeChannelRegistryEntry): void {
  entry.attempt++
  entry.onUnavailable?.()
}

function statusName(status: unknown): string {
  const value = (status as { value?: unknown } | null)?.value
  return String(value ?? status)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function registryEntry(entry: InternalElectronRealtimeChannelRegistryEntry): ElectronRealtimeChannelRegistryEntry {
  return {
    id: entry.id,
    label: entry.label,
    status: entry.status,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

function safeRemoveChannel(
  client: ElectronRealtimeClient,
  channel: ElectronManagedRealtimeChannel,
  label: string
): Promise<void> {
  try {
    return Promise.resolve(client.removeChannel(channel)).then(() => undefined, (error: unknown) => {
      console.error(`[Electron Realtime] ${label} removeChannel failed`, error)
    })
  } catch (error) {
    console.error(`[Electron Realtime] ${label} removeChannel failed`, error)
    return Promise.resolve()
  }
}
