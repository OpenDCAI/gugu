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
    setAuth: (accessToken: string) => unknown | Promise<unknown>
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
  accessToken: string
  label: string
  createChannel?: () => ElectronManagedRealtimeChannel
  onStatus?: (status: string, err?: Error) => void
  unsubscribeOnStatus?: (status: string, err?: Error) => boolean
  reconnectOnStatus?: (status: string, err?: Error) => boolean
}

type InternalElectronRealtimeChannelRegistryEntry = ElectronRealtimeChannelRegistryEntry & {
    accessToken: string
    channel: ElectronManagedRealtimeChannel
    client: ElectronRealtimeClient
    createChannel: (() => ElectronManagedRealtimeChannel) | null
    reconnectAttempt: number
    reconnectTimer: ReturnType<typeof setTimeout> | null
    active: boolean
    subscribedOnce: boolean
    onStatus: (status: string, err?: Error) => void
    reconnectOnStatus: (status: string, err?: Error) => boolean
    unsubscribeOnStatus: (status: string, err?: Error) => boolean
  }

const registry = new Map<string, InternalElectronRealtimeChannelRegistryEntry>()
const debugStatusHandlers = new Map<string, (status: string, err?: Error) => void>()
let nextChannelId = 1

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
    accessToken: options.accessToken,
    channel,
    client,
    createChannel: options.createChannel ?? null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    active: true,
    subscribedOnce: false,
    onStatus: options.onStatus ?? (() => undefined),
    reconnectOnStatus: options.reconnectOnStatus ?? (() => false),
    unsubscribeOnStatus: options.unsubscribeOnStatus ?? (() => false)
  })

  await subscribeRegistryEntry(id, false)

  // 交回的 promise 在这条退完时落定:同名 topic 要等它退完再订(realtime-js 在那之前会把正在退的那条交回来)。
  return () => {
    const entry = registry.get(id)
    if (!entry) return Promise.resolve()
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
  for (const entry of registry.values()) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
  }
  registry.clear()
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

  setRegistryStatus(id, reconnecting ? 'reconnecting' : 'authenticating')
  try {
    await entry.client.realtime.setAuth(entry.accessToken)
  } catch (error) {
    setRegistryStatus(id, 'auth_error', errorMessage(error))
    scheduleReconnect(id)
    return
  }
  const current = registry.get(id)
  if (!current?.active) return
  setRegistryStatus(id, 'subscribing')
  const subscribedChannel = current.channel
  const handleSubscribeStatus = (status: string, err?: Error) => {
    const latest = registry.get(id)
    // A replaced physical channel can report CLOSED during (or even after) its intentional
    // unsubscribe. It no longer owns this registry entry, so its callback must not schedule
    // another reconnect for the fresh channel.
    if (!latest?.active || latest.channel !== subscribedChannel) return
    const name = statusName(status)
    if (name === 'CLOSED' && latest.status === 'reconnecting') return
    latest.onStatus(status, err)
    if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
      clearReconnectTimer(id)
      latest.subscribedOnce = true
      latest.reconnectAttempt = 0
      setRegistryStatus(id, 'subscribed')
      return
    }
    if (latest.subscribedOnce && latest.reconnectOnStatus(status, err)) {
      setRegistryStatus(id, name === 'CLOSED' ? 'closed' : 'error', name)
      scheduleReconnect(id)
      return
    }
    if (!latest.unsubscribeOnStatus(status, err)) return
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
  if (!entry || entry.reconnectTimer || !entry.createChannel) return
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

async function retryNow(id: string): Promise<void> {
  const entry = registry.get(id)
  if (!entry?.active || !entry.createChannel) return
  clearReconnectTimer(id)
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
  const nextChannel = entry.createChannel()
  fresh.channel = nextChannel
  await subscribeRegistryEntry(id, true)
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
