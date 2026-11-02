import { callDeviceRpc } from '@/lib/deviceRpc'
import { getCurrentAuthUserId } from '@/lib/supabase'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'
import { nativeAgent, phoneAgentAvailable } from './nativeAgent'

const STARTUP_READS = new Set(['sessionTimeline.sessionCreateOptions', 'sessionTimeline.sessionCreateModels'])

/** A cached online device may reach the page while its new Node process is still starting. */
function localCall(ownerId: string, deviceId: string, id: string, channel: string, args: unknown[], timeout?: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const timeoutMs = timeout ?? (channel === 'sessionTimeline.sessionCreate' ? 180_000 : 12_000)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal?.removeEventListener('abort', abort)
      reject(Object.assign(new Error(channel === 'sessionTimeline.sessionCreate'
        ? '手机还没有确认这次创建，请用原来的内容继续同一次创建。'
        : '手机尚未返回操作结果，请重试。'), { code: 'host_call_timeout', requestId: id, deviceId }))
    }, timeoutMs)
    const finish = (error: unknown, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(signal?.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    void (async () => {
      let delayMs = 100
      while (!settled) {
        try {
          const reply = await nativeAgent.hostCall({ ownerId, id, channel, args })
          if (settled) return
          if (reply.error?.code === 'host_not_ready' && STARTUP_READS.has(channel)) {
            await new Promise((done) => setTimeout(done, delayMs))
            delayMs = Math.min(delayMs * 2, 1000)
            continue
          }
          if (reply.error) finish(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
          else finish(null, reply.result)
          return
        } catch (error) { finish(error); return }
      }
    })()
  })
}

/** The same host methods locally and remotely; phone hosts do not expose a workspace pipe. */
export async function invokePhoneHost<T>(deviceId: string, channel: string, args: unknown[], requestId: string = crypto.randomUUID(), timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const ownerId = await getCurrentAuthUserId()
  if (phoneAgentAvailable() && thisPhoneDeviceId(ownerId) === deviceId) {
    return localCall(ownerId, deviceId, requestId, channel, args, timeoutMs, signal) as Promise<T>
  }
  const reply = await callDeviceRpc<{ value: T }>(deviceId, 'taskhost.call', { channel, args }, { timeoutMs: timeoutMs ?? (channel === 'sessionTimeline.sessionCreate' ? 180_000 : 12_000), signal })
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
  if (!reply.result || !('value' in reply.result)) throw new Error('手机尚未返回操作结果，请重试')
  return reply.result.value
}
