import { useEffect, useRef, useState } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionpageQueueAction } from '@gugu/session-core/session-record/contract'
import { useConversationQueue, type ConversationQueueTarget } from '@/components/chat/useConversationQueue'
import { assistantTimelineClient, changeConversationQueue } from '@/components/assistant/assistantTimelineClient'
import { deleteQueuedSessionInput, editQueuedSessionInput, releaseQueuedSessionInput, reorderQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { messageForUser } from '@/lib/userFacingError'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import { canReleasePhoneInput, phoneManualHostPrompts, phoneQueuedPrompts } from './phone-input-queue'

/** Keep queue editing and its main-composer reservation shared; only the queue's owner handles a mutation. */
export function usePhoneInputQueue(target: ConversationQueueTarget, inputs: readonly SessionInput[],
  hosted: Parameters<typeof phoneManualHostPrompts>[0], turns: readonly TranscriptTurn[],
  working: boolean, stopping: boolean, ready: boolean, steers: boolean) {
  const [error, setError] = useState<{ key: string; text: string } | null>(null)
  const key = `${target.deviceId}/${target.sessionId}`
  const current = useRef(key)
  current.current = key
  const releasing = useRef(new Set<string>())
  const local = phoneQueuedPrompts(inputs)
  const remote = phoneManualHostPrompts(hosted)
  const write = async (action: SessionpageQueueAction) => {
    if (action.kind === 'reorder') {
      const localIds = action.ids.filter(id => local.some(prompt => prompt.id === id))
      const remoteIds = action.ids.filter(id => remote.some(prompt => prompt.id === id))
      if (localIds.length) await reorderQueuedSessionInputs(target.sessionId, localIds)
      if (remoteIds.length) await changeConversationQueue(target.local, target.deviceId, target.sessionId, { ...action, ids: remoteIds }, target.phoneHost)
    } else if (!local.some(prompt => prompt.id === action.id)) {
      await changeConversationQueue(target.local, target.deviceId, target.sessionId, action, target.phoneHost)
    } else if (action.kind === 'edit') {
      if (!await editQueuedSessionInput(action.id, action.text, action.queueEdit)) throw new Error(translateSessionMessage('acpFailure.editQueued'))
    } else if (action.kind === 'delete') {
      await deleteQueuedSessionInput(action.id)
    } else {
      if (working && !action.steers) {
        const client = target.phoneHost ? phoneTimelineClient : assistantTimelineClient(target.local)
        await client.cancelSessionTurn(target.deviceId, target.sessionId)
      }
      await releaseQueuedSessionInput(target.sessionId, turns, action.id)
    }
  }
  const queue = useConversationQueue(target, [...remote, ...local], working, steers, write)
  useEffect(() => {
    if (!local.length || releasing.current.has(key) || !canReleasePhoneInput(ready, working, stopping, turns)) return
    releasing.current.add(key)
    void releaseQueuedSessionInput(target.sessionId, turns).then(() => {
      if (current.current === key) setError(null)
    }, cause => {
      if (current.current === key) setError({ key, text: messageForUser(cause) })
    }).finally(() => { releasing.current.delete(key) })
  }, [inputs, turns, ready, working, stopping, target.sessionId, key, local.length])
  return { ...queue, error: queue.error ?? (error?.key === key ? error.text : null) }
}
