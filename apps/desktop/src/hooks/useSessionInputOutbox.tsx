import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { NativeConversationReadHost } from '@/components/chat/NativeConversationReadHost'
import { ChatSummariesHost } from '@/components/chat/ChatSummariesHost'
import { useLocalSessionDirectory } from './useLocalSessionDirectory'
import { useEffect, useRef } from 'react'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useDevicesStore } from '@/store/devicesContext'
import { getRendererSession } from '@/lib/sessionPublication'
import { platform } from '@/platform'
import { SessionInputFailureError, SessionInputOutbox, openSessionInputStorage } from '@/lib/sessionInputOutbox'
import { rendererLogger } from '@/lib/log'
import { liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** Runs with the signed-in shell, including while the conversation itself is closed. */
export function SessionInputOutboxHost({ accountId }: { accountId: string }) {
  const { devices, phones } = useDevicesStore()
  useLocalSessionDirectory(accountId, devices.find(device => device.is_current_device)?.device_id)
  const hosts = useRef([...devices, ...(phones ?? [])])
  hosts.current = [...devices, ...(phones ?? [])]
  useEffect(() => {
    let active = true
    const own = state()
    own.accountId = accountId
    own.rows = EMPTY
    const valid = () => active && own.accountId === accountId && getRendererSession()?.user.id === accountId
    own.valid = valid
    let queue: SessionInputOutbox | null = null
    const refresh = async () => {
      const rows = await queue?.list()
      if (valid() && rows) { own.rows = rows; changed() }
    }
    own.queue = openSessionInputStorage().then(storage => {
      queue = new SessionInputOutbox(accountId, storage, async input => {
        if (!valid()) throw new Error('Session input account changed')
        const device = hosts.current.find(device => device.device_id === input.deviceId)
        if (device && !device.is_online) throw new SessionInputFailureError({ code: 'host-offline' })
        if (input.deviceId && !device?.is_current_device && !(device && isPhoneDevice(device))) {
          const summary = liveDeviceSessions()[input.deviceId]?.sessions.find(session => session.conversationId === input.sessionId)
          if (summary?.nativeInputVersion !== 1) throw new SessionInputFailureError({ code: 'host-not-ready' })
        }
        if (device && isPhoneDevice(device)) {
          const { invokePhoneHost } = await import('@/mobile/local-agent/phoneHostRpc')
          const result = await invokePhoneHost<{ accepted?: boolean }>(device.device_id, 'sessionTimeline.sessionSend', [{ conversationId: input.sessionId, text: input.text, clientRequestId: input.id }], input.id)
          if (result.accepted !== true) throw new SessionInputFailureError({ code: 'phone-unconfirmed' })
          await queue!.confirm(input.sessionId, [input.id])
        } else if (platform.kind === 'electron') {
          const { rpcOn } = await import('@/session/renderer/lib/ipc')
          const result = await rpcOn(input.deviceId).sessionTimeline.sessionSend({ conversationId: input.sessionId, text: input.text, clientMessageId: input.id, ...(input.attachments?.length ? { attachments: input.attachments } : {}) })
          if (!result.ok) throw new Error(result.error.message)
          if (result.value.clientMessageId !== input.id) throw new Error('Session host acknowledged another input')
        } else {
          const { sendSessionText } = await import('@/mobile/agent-watch/sessionpage-rpc')
          if (!input.deviceId) throw new Error('Remote session input has no device')
          await sendSessionText(input.deviceId, input.sessionId, input.text, input.id, input.attachments)
        }
      }, valid, () => { void refresh().catch(report) })
      void refresh().catch(report)
      return queue
    })
    const report = (error: unknown) => rendererLogger('session/input-outbox').warn({ error: String(error) }, 'Native input queue could not be reconciled')
    const flush = () => { void own.queue?.then(queue => queue.flush()).catch(report) }
    const timer = setInterval(flush, 15_000)
    window.addEventListener('online', flush)
    flush()
    changed()
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('online', flush)
      if (own.accountId === accountId) { own.accountId = null; own.queue = null; own.rows = EMPTY; changed() }
    }
  }, [accountId])
  useEffect(() => { void state().queue?.then(queue => queue.flush()).catch(() => undefined) }, [devices, phones])
  return <><ChatSummariesHost /><NativeConversationReadHost /></>
}
