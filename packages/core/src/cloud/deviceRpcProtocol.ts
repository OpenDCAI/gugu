import { unwrapPayload } from './payload'

/**
 * Device RPC wire protocol.
 *
 * Channels (private Supabase Realtime topics authorized by realtime.messages RLS — it checks `gugu`, a device of
 * `auth.uid()`, `rpc`, i.e. the first three parts; a fourth part passes the same policy):
 *   `gugu:{deviceId}:rpc`          the machine's shared topic: an asker attaching (`taskhost.attach`), the host being up
 *                                  (`taskhost.ready`) and alive (`taskhost.alive`) — nothing else (protocol 9, #7233)
 *   `gugu:{deviceId}:rpc:{asker}`  one asker's own topic, both ways: its requests, their replies, its windows' frames.
 *                                  Nobody else subscribes to it, so nobody else receives them (before #7233 every
 *                                  client of the machine received every reply, picture and upload).
 * Both outbound and inbound event name: `broadcast`. The semantic message
 * type lives in payload.type.
 *
 * Outbound payload: { type, request_id, user_id, payload }
 * Inbound payload:  { type: `${type}:reply`, request_id, result?, error? }
 */

export type DeviceRpcError = { code: string; message: string }

export type DeviceRpcResponse<T> = {
  result?: T
  error?: DeviceRpcError
}

export interface DeviceRpcRequestEnvelope {
  type: string
  request_id: string
  user_id: string
  payload: unknown
}

export interface DeviceRpcReplyEnvelope {
  type: string
  requestId: string
  result?: unknown
  error?: DeviceRpcError
}

export function deviceRpcChannelName(deviceId: string): string {
  return `gugu:${deviceId}:rpc`
}

/** An asker's id: what its own topic is named by. No `:` (the topic's parts are split on it). */
export const DEVICE_RPC_ASKER_ID = /^[A-Za-z0-9_-]{8,64}$/

export function deviceRpcAskerChannelName(deviceId: string, asker: string): string {
  if (!DEVICE_RPC_ASKER_ID.test(asker)) throw new Error(`invalid device RPC asker id: ${asker}`)
  return `${deviceRpcChannelName(deviceId)}:${asker}`
}

/**
 * On the shared topic, an asker attaches: `{ asker, protocol }`. The host joins the asker's topic and answers there
 * (`taskhost.attach:reply` `{ attached: true, protocol }`); a host older than protocol 9 answers on the shared topic
 * with `unknown_method`.
 */
export const DEVICE_RPC_ATTACH = 'taskhost.attach'
/** On an asker's topic, from the host, just before it leaves it (idle, or making room): attach again before asking. */
export const DEVICE_RPC_DETACHED = 'taskhost.detached'
/**
 * From the host, every DEVICE_RPC_ALIVE_MS, on the shared topic and on every asker topic it is on: the frame that keeps
 * a healthy channel from looking stale to the subscriber's watchdog (#840: a stalled backend stops delivering while the
 * socket and its heartbeat stay up — only a broadcast that does not arrive tells).
 */
export const DEVICE_RPC_ALIVE = 'taskhost.alive'
export const DEVICE_RPC_ALIVE_MS = 60_000
/** A channel that received nothing for this long is taken for dead (two missed alive frames). Same rule as #840's. */
export const DEVICE_RPC_STALE_MS = 2 * 60_000

/** The `type` of a host frame that carries no request id (ready / alive / detached / window frames), or null. */
export function deviceRpcFrameType(payload: unknown): string | null {
  const inner = unwrapPayload(payload)
  const direct = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const type = (typeof inner.type === 'string' && inner.type) || (typeof direct.type === 'string' && direct.type) || ''
  return type || null
}

export function deviceRpcReplyType(type: string): string {
  return `${type}:reply`
}

export function createDeviceRpcRequestEnvelope(
  type: string,
  requestId: string,
  userId: string,
  payload: unknown,
): DeviceRpcRequestEnvelope {
  return { type, request_id: requestId, user_id: userId, payload }
}

export function parseDeviceRpcRequest(payload: unknown): DeviceRpcRequestEnvelope | null {
  const direct = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {}
  const inner = unwrapPayload(payload)
  const type =
    (typeof inner.type === 'string' && inner.type) ||
    (typeof direct.type === 'string' && direct.type) ||
    ''
  const requestId =
    (typeof inner.request_id === 'string' && inner.request_id) ||
    (typeof direct.request_id === 'string' && direct.request_id) ||
    ''
  if (!type || !requestId) return null
  const userId =
    (typeof inner.user_id === 'string' && inner.user_id) ||
    (typeof direct.user_id === 'string' && direct.user_id) ||
    ''
  return {
    type,
    request_id: requestId,
    user_id: userId,
    payload: inner.payload ?? direct.payload,
  }
}

export function createDeviceRpcReplyEnvelope(
  type: string,
  requestId: string,
  response: DeviceRpcResponse<unknown>,
): { type: string; request_id: string; result?: unknown; error?: DeviceRpcError } {
  return {
    type: deviceRpcReplyType(type),
    request_id: requestId,
    result: response.result,
    error: response.error,
  }
}

export function parseDeviceRpcReply(payload: unknown): DeviceRpcReplyEnvelope | null {
  const direct = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {}
  const inner = unwrapPayload(payload)
  const type =
    (typeof inner.type === 'string' && inner.type) ||
    (typeof direct.type === 'string' && direct.type) ||
    ''
  const requestId =
    (typeof inner.request_id === 'string' && inner.request_id) ||
    (typeof direct.request_id === 'string' && direct.request_id) ||
    ''
  if (!type || !requestId) return null

  const error = inner.error ?? direct.error
  return {
    type,
    requestId,
    result: inner.result ?? direct.result,
    error:
      error && typeof error === 'object'
        ? {
            code: String((error as Record<string, unknown>).code ?? 'internal_error'),
            message: String((error as Record<string, unknown>).message ?? 'Unknown error'),
          }
        : undefined,
  }
}

export function subscribeStatusName(status: unknown): string {
  const value = (status as { value?: unknown } | null)?.value
  return String(value ?? status)
}

export function isSubscribeFailure(status: unknown): boolean {
  const name = subscribeStatusName(status)
  return (
    name === 'CHANNEL_ERROR' ||
    name === 'TIMED_OUT' ||
    name === 'CLOSED' ||
    name.endsWith('.CHANNEL_ERROR') ||
    name.endsWith('.TIMED_OUT') ||
    name.endsWith('.CLOSED')
  )
}
