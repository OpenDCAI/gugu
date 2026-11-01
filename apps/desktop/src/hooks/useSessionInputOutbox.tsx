import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { NativeConversationReadHost } from '@/components/chat/NativeConversationReadHost'
import { ChatSummariesHost } from '@/components/chat/ChatSummariesHost'
import { useLocalSessionDirectory } from './useLocalSessionDirectory'
import { useEffect, useRef } from 'react'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { useDevicesStore } from '@/store/devicesContext'
import { getRendererSession } from '@/lib/sessionPublication'
import { platform } from '@/platform'
import { SessionInputFailureError, SessionInputOutbox, openSessionInputStorage, withoutQueuedAttachments, type SessionInput } from '@/lib/sessionInputOutbox'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { rendererLogger } from '@/lib/log'
import { toast } from '@renderer/lib/hooks/use-toast'
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
    const oldAttachmentHost = (input: Pick<SessionInput, 'deviceId' | 'sessionId' | 'files'>) => {
      if (!input.files?.length || !input.deviceId) return false
      const device = hosts.current.find(row => row.device_id === input.deviceId)
      if (!device?.is_online || device.is_current_device) return false
      const version = device.capabilities.remote_protocol
      if (isPhoneDevice(device)) return typeof version !== 'number' || version < REMOTE_PROTOCOL_VERSION
      const native = liveDeviceSessions()[input.deviceId]?.sessions.find(row => row.conversationId === input.sessionId)?.nativeInputVersion
      return native === 1
    }
    let queue: SessionInputOutbox | null = null
    const refresh = async () => {
      const rows = await queue?.list()
      if (valid() && rows) { own.rows = rows; changed() }
    }
    own.queue = openSessionInputStorage().then(storage => {
      queue = new SessionInputOutbox(accountId, storage, async input => {
        if (!valid()) throw new Error('Session input account changed')
        const device = hosts.current.find(device => device.device_id === input.deviceId)
        // This computer is named either way (no device id, or its own id); either way its own host answers over IPC.
        const remoteId = !input.deviceId || device?.is_current_device ? null : input.deviceId
        if (remoteId && device && !device.is_online) throw new SessionInputFailureError({ code: 'host-offline' })
        if (oldAttachmentHost(input)) {
          const caption = withoutQueuedAttachments(input, input.files!.length)
          input.text = caption.text
          delete input.files
          delete input.failure
          await storage.put(input)
        }
        if (remoteId && !(device && isPhoneDevice(device))) {
          const summary = liveDeviceSessions()[remoteId]?.sessions.find(session => session.conversationId === input.sessionId)
          if (summary?.nativeInputVersion !== 1 && summary?.nativeInputVersion !== 2) throw new SessionInputFailureError({ code: 'host-not-ready' })
        }
        let failedFiles = 0
        if (device && isPhoneDevice(device)) {
          const { invokePhoneHost } = await import('@/mobile/local-agent/phoneHostRpc')
          const result = await invokePhoneHost<{ accepted?: boolean; failedFiles?: number }>(device.device_id, 'sessionTimeline.sessionSend', [{ conversationId: input.sessionId, text: input.text, clientRequestId: input.id, ...(input.files?.length ? { files: input.files } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}) }], input.id)
          failedFiles = result.failedFiles ?? 0
          if (!result.accepted) throw new SessionInputFailureError({ code: 'phone-unconfirmed' })
        } else if (platform.kind === 'electron') {
          const { rpcOn } = await import('@/session/renderer/lib/ipc')
          const result = await rpcOn(remoteId).sessionTimeline.sessionSend({ conversationId: input.sessionId, text: input.text, clientMessageId: input.id, ...(input.files?.length ? { files: input.files } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}) })
          if (!result.ok) throw new Error(result.error.message)
          failedFiles = result.value.failedFiles ?? 0
          if (result.value.clientMessageId !== input.id) throw new Error('Session host acknowledged another input')
        } else {
          const { sendSessionText } = await import('@/mobile/agent-watch/sessionpage-rpc')
          if (!input.deviceId) throw new Error('Remote session input has no device')
          const result = await sendSessionText(input.deviceId, input.sessionId, input.text, input.id, input.files)
          failedFiles = result.failedFiles ?? 0
        }
        if (failedFiles) toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: translateSessionMessage('composer.attachmentsUnavailable', { count: failedFiles }), variant: 'destructive' })
      }, valid, () => { void refresh().catch(report) }, input => {
        if (oldAttachmentHost(input)) throw new Error(translateSessionMessage('composer.attachmentHostUpdateRequired'))
      })
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
