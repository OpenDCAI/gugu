import { enqueueSessionInput, sessionInputOutboxAvailable } from '@/lib/sessionInputOutboxBridge'
import { machineRegistry } from '@renderer/lib/machine-routing'
import { machineLinkState } from '@renderer/lib/machine-clients'
import { toast } from '@renderer/lib/hooks/use-toast'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store'

export function canQueueNativeInput(store: AcpChatStore): boolean {
  const machine = machineRegistry.machineOf(store.runtimeSessionId)
  return machine !== null && machineLinkState(machine) !== 'open'
}

/** Native admission remains on the host; the sender keeps the input until its acknowledgement. */
export async function queueNativeInput(store: AcpChatStore, text: string, attachments: readonly AcpPromptAttachment[]): Promise<boolean> {
  if (!sessionInputOutboxAvailable()) return false
  await enqueueSessionInput({ deviceId: machineRegistry.machineOf(store.runtimeSessionId), sessionId: store.runtimeSessionId, text, ...(attachments.length ? { attachments: attachments.map(attachment => attachment.ref) } : {}) }).catch(error => {
    store.setDraftText([text, store.draftText].filter(Boolean).join('\n'))
    toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: String(error), variant: 'destructive' })
    throw error
  })
  return true
}
