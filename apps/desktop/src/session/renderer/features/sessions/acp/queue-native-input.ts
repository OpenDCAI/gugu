import { enqueueSessionInput, sessionInputOutboxAvailable } from '@/lib/sessionInputOutboxBridge'
import { machineRegistry } from '@renderer/lib/machine-routing'
import { machineLinkState } from '@renderer/lib/machine-clients'
import type { TurnFileRef } from '@gugu/session-core/session-record/contract'
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store'

export function canQueueNativeInput(store: AcpChatStore): boolean {
  const machine = machineRegistry.machineOf(store.runtimeSessionId)
  return machine !== null && machineLinkState(machine) !== 'open'
}

/**
 * The one send path of a task page (custody chain): the sender's outbox holds the input until the host's
 * session_pending accepts it, then the host row is its only owner. A side chat sends to its fork entry by its own id.
 * A failure throws; the store's `submitPrompt` says it and its caller keeps the words.
 */
export async function sendThroughCustody(store: AcpChatStore, text: string, attachments: readonly AcpPromptAttachment[], files: readonly TurnFileRef[] = []): Promise<void> {
  if (!sessionInputOutboxAvailable()) throw new Error('Task input needs a signed-in account')
  await enqueueSessionInput({ deviceId: machineRegistry.machineOf(store.runtimeSessionId), sessionId: store.runtimeSessionId, text, ...(attachments.length ? { attachments: attachments.map(attachment => attachment.ref) } : {}), ...(files.length ? { files: [...files] } : {}) })
}
