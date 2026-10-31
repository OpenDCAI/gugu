import { enqueueSessionInput, sessionInputOutboxAvailable } from '@/lib/sessionInputOutboxBridge'
import { machineRegistry } from '@renderer/lib/machine-routing'
import { machineLinkState } from '@renderer/lib/machine-clients'
import { toast } from '@renderer/lib/hooks/use-toast'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store'
import { rendererLogger } from '@/lib/log'

export function canQueueNativeInput(store: AcpChatStore): boolean {
  const machine = machineRegistry.machineOf(store.runtimeSessionId)
  return machine !== null && machineLinkState(machine) !== 'open'
}

/**
 * The one send path of a task page (custody chain): the sender's outbox holds the input until the host's
 * session_pending accepts it, then the host row is its only owner. A side-chat view is not a session-life session
 * and keeps its runtime's own prompt path.
 */
export async function sendThroughCustody(store: AcpChatStore, text: string, attachments: readonly AcpPromptAttachment[]): Promise<void> {
  if (store.runtimeSessionId !== store.sessionId) { store.submitPrompt(text, [...attachments]); return }
  if (!sessionInputOutboxAvailable()) throw new Error('Task input needs a signed-in account; the draft is kept')
  await enqueueSessionInput({ deviceId: machineRegistry.machineOf(store.runtimeSessionId), sessionId: store.runtimeSessionId, text, ...(attachments.length ? { attachments: attachments.map(attachment => attachment.ref) } : {}) }).catch(error => {
    store.setDraftText([text, store.draftText].filter(Boolean).join('\n'))
    rendererLogger('session/input-outbox').warn({ sessionId: store.runtimeSessionId, error: String(error) }, 'Native input could not be retained; draft restored')
    toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: translateSessionMessage('composer.inputKeptInDraft'), variant: 'destructive' })
    throw error
  })
}
