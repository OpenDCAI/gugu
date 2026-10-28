import type { AssistantWorkEventInput } from './assistantWorkOutbox'
import { withSessionAttachments, type SessionAttachmentRef } from './sessionAttachments'
import { assistantWorkDeliveryTarget, type AssistantWorkAddress } from './assistantWorkRouting'

/** Old hosts reject this operation before injecting anything, rather than ignoring a stable message ID. */
export const ASSISTANT_WORK_DELIVERY_RPC = 'assistantWork.deliver'
export type AssistantWorkDeliveryReference = { assistant_id: string; work_id: string; message_id: string }
export type AssistantWorkDeliveryEvent = AssistantWorkEventInput & {
  delivery_target?: AssistantWorkAddress | null
  work_id: string
  platform_received_at: string
  source_available: boolean
}

const fail = (code: string) => Object.assign(new Error(code), { code })
export function createAssistantWorkDeliveryReceiver(deps: {
  context(): Promise<{ ownerId: string; deviceId: string } | null>
  read(ref: AssistantWorkDeliveryReference, signal?: AbortSignal): Promise<AssistantWorkDeliveryEvent | null>
  deliver(event: AssistantWorkDeliveryEvent, signal?: AbortSignal): Promise<{ admitted: boolean; messageId: string; receipt?: Record<string, unknown> }>
}) {
  type Admission = { status: 'admitted'; messageId: string; receipt?: Record<string, unknown> } | { status: 'pending' }
  const admissions = new Map<string, Promise<Admission>>()
  return {
    async receive(input: unknown, ownerId: string, signal?: AbortSignal): Promise<{ status: 'admitted'; messageId: string; receipt?: Record<string, unknown> } | { status: 'pending' }> {
      const context = await deps.context()
      if (!context || context.ownerId !== ownerId) throw fail('OWNER_CHANGED')
      const ref = input as AssistantWorkDeliveryReference | null
      if (!ref || ![ref.assistant_id, ref.work_id, ref.message_id].every(value => typeof value === 'string' && value.length > 0)) throw fail('INVALID_DELIVERY_REFERENCE')
      signal?.throwIfAborted()
      const key = JSON.stringify([ownerId, context.deviceId, ref.assistant_id, ref.work_id, ref.message_id])
      const existing = admissions.get(key)
      if (existing) return existing
      const admitting = (async (): Promise<Admission> => {
      // Deliberately ignore any cached content/attachments supplied on the wire.
      const canonical={ assistant_id: ref.assistant_id, work_id: ref.work_id, message_id: ref.message_id }
      const event = await (signal ? new Promise<AssistantWorkDeliveryEvent|null>((resolve,reject)=>{
        const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason)}
        signal.addEventListener('abort',aborted,{once:true})
        Promise.resolve().then(()=>{signal.throwIfAborted();return deps.read(canonical,signal)}).then(
          value=>{signal.removeEventListener('abort',aborted);resolve(value)},
          error=>{signal.removeEventListener('abort',aborted);reject(error)},
        )
      }) : deps.read(canonical))
      if (!event || event.message_id !== ref.message_id || event.work_id !== ref.work_id) throw fail('WORK_MESSAGE_NOT_FOUND')
      if (!event.source_available || typeof event.content !== 'string') throw fail('SOURCE_UNAVAILABLE')
      const current = await deps.context()
      if (current?.ownerId !== ownerId || current.deviceId !== context.deviceId) throw fail('OWNER_CHANGED')
      const target = assistantWorkDeliveryTarget(event)
      if (!target) return { status: 'pending' }
      if (target.device_id !== context.deviceId) throw fail('WRONG_DEVICE')
      withSessionAttachments('', event.attachment_refs as SessionAttachmentRef[] | undefined)
      signal?.throwIfAborted()
      const routed = { ...event, to_device_id: target.device_id, to_session_id: target.session_id }
      const receipt = await (signal ? deps.deliver(routed, signal) : deps.deliver(routed))
      return receipt.admitted && receipt.messageId === ref.message_id ? { status: 'admitted', messageId: ref.message_id, ...(receipt.receipt ? {receipt: receipt.receipt} : {}) } : { status: 'pending' }
      })()
      admissions.set(key, admitting)
      const clean = () => { if (admissions.get(key) === admitting) admissions.delete(key) }
      void admitting.then(clean, clean)
      return admitting
    },
  }
}
