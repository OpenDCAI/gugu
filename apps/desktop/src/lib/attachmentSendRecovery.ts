import { AttachmentsError, type AttachmentsEndpoint, type CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from './chat'
import { i18n } from '../i18n'
import { commitPreparedChatAttachment, type PreparedChatAttachment } from './attachmentsEndpoint'
import { AttachmentStageTimeout, linkedAttachmentSignal, type AttachmentSendTiming } from './attachmentSendTiming'
import { readMessageCreatedRevision, type AccountRevisionListener } from './accountRevisionCoordinator'
import { xhrAttachmentUpload } from './attachmentUploadTransport'

export type ObserveAttachmentMessage = (id: string, receive: (row: MessageItem) => void) => () => void
const MAX_ATTEMPTS = 3
const NATIVE_OBSERVATION_MS = 10 * 60_000
export function retryableAttachmentError(error: unknown): boolean {
  return error instanceof AttachmentStageTimeout || error instanceof TypeError
    || error instanceof AttachmentsError && (error.status === 408 || error.status === 429 || error.status >= 500)
}
export function attachmentAttemptEndpoint(endpoint: AttachmentsEndpoint, signal: AbortSignal): AttachmentsEndpoint {
  return { ...endpoint, fetch: (input, init) => (endpoint.fetch ?? fetch)(input, {
    ...init, signal: init?.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }), upload: (url, init, progress) => (endpoint.upload ?? xhrAttachmentUpload)(url, {
    ...init, signal: init.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }, progress) }
}
export async function retryAttachmentUpload<T>(run: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(attempt) } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !retryableAttachmentError(error)) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 500))
    }
  }
}

/** Confirmation is scoped to this send and account; it also works after leaving the current chat. */
export function observeAttachmentMessage(
  subscribe: (event: 'message_created', listener: AccountRevisionListener) => () => void,
  senderId: string, chatId: string,
): ObserveAttachmentMessage {
  return (id, receive) => subscribe('message_created', operations => {
    for (const operation of operations) {
      const arrival = readMessageCreatedRevision(operation.payload)
      if (arrival.chatId !== chatId || arrival.messageId !== id || !arrival.message) continue
      const row = arrival.message as typeof arrival.message & { deleted_at?: unknown; deleted_for_user_ids?: unknown }
      if (row.deleted_at || Array.isArray(row.deleted_for_user_ids) && row.deleted_for_user_ids.includes(senderId)) continue
      const item = messageItemFromRow(row, senderId)
      if (item) receive(item)
    }
  })
}

/** Commit already returns messages_view. A second read is recovery, never a prerequisite for displaying success. */
export async function settleAttachmentSend(args: {
  endpoint: AttachmentsEndpoint; prepared: PreparedChatAttachment; commit: Omit<CommitArgs, 'staging_key'>
  timing: AttachmentSendTiming; observeMessage?: ObserveAttachmentMessage; onLateMessage?: (row: MessageItem) => void
}): Promise<MessageItem | null> {
  const { endpoint, prepared, commit, timing } = args
  const cancellation = new AbortController()
  const authoritative = (row: MessageItem | null): row is MessageItem => !!row && row.id === commit.message_id
    && row.chat_id === commit.chat_id && row.sender_user_id === commit.sender_user_id && row.seq > 0 && row.content_type === 'attachment'
  let source = 'commit', observed: MessageItem | undefined, unknown = false
  let observationLimit: ReturnType<typeof setTimeout> | undefined
  let receive: (row: MessageItem) => void = () => {}
  const confirmed = new Promise<MessageItem>(resolve => {
    receive = row => { if (authoritative(row)) { source = 'realtime'; observed = row; resolve(row) } }
  })
  const stop = args.observeMessage?.(commit.message_id, receive)
  const readback = (attempt: number, quiet = false) => timing.stage('readback', attempt, () => chatService.getMessageById(commit.message_id, commit.sender_user_id), cancellation.signal, quiet ? { logResult: authoritative } : undefined)
  const publish = async () => {
    let failure: unknown
    for (let attempt = 1; ; attempt++) {
      try {
        // A native publication may have written a folder revision before its IPC
        // response was lost. Poll its message, never publish that file twice.
        if (attempt > 1 && 'local' in prepared) throw failure
        const raw = await timing.stage('commit', attempt, signal => commitPreparedChatAttachment(attachmentAttemptEndpoint(endpoint, signal), prepared, commit).then(raw => {
          if (unknown) {
            const late = messageItemFromRow(raw, commit.sender_user_id)
            if (authoritative(late)) args.onLateMessage?.({ ...late, local_send_state: null, local_send_error: null })
          }
          return raw
        }), cancellation.signal, 'local' in prepared ? { timeoutMs: null } : undefined)
        const row = messageItemFromRow(raw, commit.sender_user_id)
        if (authoritative(row)) return row
        // An incomplete acknowledgement must be verified, never fabricated into a successful message.
        failure = new Error(i18n.t('composer.attachmentPersistenceFailed', { ns: 'messaging', fileName: commit.file_name }))
      } catch (error) { failure = error }
      if (cancellation.signal.aborted) throw cancellation.signal.reason
      try {
        const row = await readback(attempt)
        if (authoritative(row)) { source = 'readback'; return row }
      } catch (error) {
        // The write error remains the reason for retrying; each read failure is recorded by stage timing.
        if (cancellation.signal.aborted) throw error
      }
      if (attempt >= MAX_ATTEMPTS || !retryableAttachmentError(failure)) throw failure
      // Reuse the staging key and message ID. Replaying a cloud commit is idempotent.
      await new Promise<void>((resolve, reject) => {
        const signal = cancellation.signal
        signal.throwIfAborted()
        const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, attempt * 500)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
  try {
    const pollNative = async (): Promise<MessageItem> => {
      for (let attempt = 1; ; attempt++) {
        cancellation.signal.throwIfAborted()
        try { const row = await readback(attempt, true); if (authoritative(row)) { source = 'readback'; return row } }
        catch (error) { if (cancellation.signal.aborted) throw error }
        await new Promise<void>((resolve, reject) => {
          const signal = cancellation.signal
          const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, Math.min(60_000, 2000 * 2 ** Math.min(attempt - 1, 5)))
          signal.addEventListener('abort', onAbort, { once: true })
        })
      }
    }
    const nativeLimit = new Promise<null>(resolve => { observationLimit = setTimeout(() => resolve(null), NATIVE_OBSERVATION_MS) })
    const row = observed ?? await Promise.race([confirmed, publish(), ...('local' in prepared ? [pollNative(), nativeLimit] : [])])
    if (!row) { unknown = true; timing.finish('unknown', 'native-observation-limit'); return null }
    timing.finish('success', source)
    return { ...row, local_send_state: null, local_send_error: null }
  } catch (error) {
    timing.finish('failed'); throw error
  } finally {
    clearTimeout(observationLimit); stop?.(); cancellation.abort(new Error('Attachment send settled'))
  }
}
