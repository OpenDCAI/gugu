import type { AssistantWorkEventInput } from './assistantWorkOutbox'
import { withSessionAttachments, type SessionAttachmentRef } from './sessionAttachments'

/** Old hosts reject this operation before injecting anything, rather than ignoring a stable message ID. */
export const ASSISTANT_WORK_DELIVERY_RPC = 'assistantWork.deliver'
export type AssistantWorkDeliveryReference = { assistant_id: string; work_id: string; message_id: string }
export type AssistantWorkDeliveryEvent = AssistantWorkEventInput & {
  work_id: string
  platform_received_at: string
  source_available: boolean
}

const fail = (code: string) => Object.assign(new Error(code), { code })
export function createAssistantWorkDeliveryReceiver(deps: {
  context(): Promise<{ ownerId: string; deviceId: string } | null>
  read(ref: AssistantWorkDeliveryReference): Promise<AssistantWorkDeliveryEvent | null>
  deliver(event: AssistantWorkDeliveryEvent): Promise<{ admitted: boolean; messageId: string; receipt?: Record<string, unknown> }>
}) {
  return {
    async receive(input: unknown, ownerId: string): Promise<{ status: 'admitted'; messageId: string; receipt?: Record<string, unknown> } | { status: 'pending' }> {
      const context = await deps.context()
      if (!context || context.ownerId !== ownerId) throw fail('OWNER_CHANGED')
      const ref = input as AssistantWorkDeliveryReference | null
      if (!ref || ![ref.assistant_id, ref.work_id, ref.message_id].every(value => typeof value === 'string' && value.length > 0)) throw fail('INVALID_DELIVERY_REFERENCE')
      // Deliberately ignore any cached content/attachments supplied on the wire.
      const event = await deps.read({ assistant_id: ref.assistant_id, work_id: ref.work_id, message_id: ref.message_id })
      if (!event || event.message_id !== ref.message_id || event.work_id !== ref.work_id) throw fail('WORK_MESSAGE_NOT_FOUND')
      if (!event.source_available || typeof event.content !== 'string') throw fail('SOURCE_UNAVAILABLE')
      const current = await deps.context()
      if (current?.ownerId !== ownerId || current.deviceId !== context.deviceId) throw fail('OWNER_CHANGED')
      if (event.to_device_id !== context.deviceId) throw fail('WRONG_DEVICE')
      withSessionAttachments('', event.attachment_refs as SessionAttachmentRef[] | undefined)
      const receipt = await deps.deliver(event)
      return receipt.admitted && receipt.messageId === ref.message_id ? { status: 'admitted', messageId: ref.message_id, ...(receipt.receipt ? {receipt: receipt.receipt} : {}) } : { status: 'pending' }
    },
  }
}
