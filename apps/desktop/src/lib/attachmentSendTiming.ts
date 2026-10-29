import { rendererLogger } from './log'
import { i18n } from '../i18n'

export const ATTACHMENT_SEND_DEADLINES = { upload: 120_000, commit: 20_000, readback: 5_000 }
export const ATTACHMENT_UPLOAD_IDLE_MS = 15_000
export type AttachmentSendStage = keyof typeof ATTACHMENT_SEND_DEADLINES
const log = rendererLogger('chat/attachments')
export class AttachmentStageTimeout extends Error {
  constructor(readonly stage: AttachmentSendStage) { super(i18n.t('composer.attachmentSendTimedOut', { ns: 'messaging' })) }
}

/** Like chatSendTiming: correlated IDs and elapsed time only, never file contents, URLs or tokens. */
export function attachmentUploadTimeoutMs(sizeBytes: number): number {
  // Reserve two minutes for setup, then allow an 8 KiB/s uplink. The signed
  // upload plan caps this allowance at its actual expiry once it arrives.
  return ATTACHMENT_SEND_DEADLINES.upload + Math.ceil(sizeBytes / 8192 * 1000)
}
export function linkedAttachmentSignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const listeners = signals.map(signal => {
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  })
  controller.signal.addEventListener('abort', () => { for (const dispose of listeners) dispose() }, { once: true })
  const aborted = signals.find(signal => signal.aborted)
  if (aborted) controller.abort(aborted.reason)
  return controller.signal
}
export function attachmentSendTiming(clientId: string, chatId: string) {
  const submitted = performance.now()
  return {
    clientId,
    async stage<T>(stage: AttachmentSendStage, attempt: number, operation: (signal: AbortSignal, capDeadline: (expiresAt: string | undefined) => void, progress: (sent?: number, total?: number) => void) => Promise<T>, parent?: AbortSignal, options?: { timeoutMs?: number | null; logResult?: (result: T) => boolean }): Promise<T> {
      const started = performance.now(), controller = new AbortController()
      const signal = parent ? linkedAttachmentSignal([parent, controller.signal]) : controller.signal
      const fields = { clientId, chatId, stage, attempt }
      const timeoutMs = options?.timeoutMs === undefined ? ATTACHMENT_SEND_DEADLINES[stage] : options.timeoutMs
      let deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs
      let lastProgressAt = Date.now(), lastSent = 0, bytesComplete = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(timeout)
        const nextDeadline = Math.min(deadline, stage === 'upload' && !bytesComplete ? lastProgressAt + ATTACHMENT_UPLOAD_IDLE_MS : Infinity)
        if (Number.isFinite(nextDeadline)) timeout = setTimeout(() => controller.abort(new AttachmentStageTimeout(stage)), Math.max(0, nextDeadline - Date.now()))
      }
      const progress = (sent?: number, total?: number) => {
        if (signal.aborted || sent !== undefined && (!Number.isFinite(sent) || sent <= lastSent)) return
        if (sent !== undefined) lastSent = sent
        if (sent !== undefined && total !== undefined && total > 0 && sent >= total) bytesComplete = true
        lastProgressAt = Date.now(); arm()
      }
      const capDeadline = (expiresAt: string | undefined) => {
        if (!expiresAt) return
        const expiry = Date.parse(expiresAt)
        if (Number.isFinite(expiry)) { deadline = Math.min(deadline, expiry); arm() }
      }
      arm()
      let onAbort: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const result = await Promise.race([aborted, Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal, capDeadline, progress) })])
        const elapsedMs = Math.round(performance.now() - started)
        if (options?.logResult?.(result) !== false) log[elapsedMs > 2000 ? 'warn' : 'info']({ ...fields, elapsedMs, outcome: 'success' }, 'attachment send stage timing')
        return result
      } catch (error) {
        log[signal.aborted && !(error instanceof AttachmentStageTimeout) ? 'info' : 'warn']({ ...fields, elapsedMs: Math.round(performance.now() - started), outcome: error instanceof AttachmentStageTimeout ? 'timeout' : signal.aborted ? 'cancelled' : 'failed' }, 'attachment send stage timing')
        throw error
      } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', onAbort); controller.abort(new Error('Attachment stage finished'))
      }
    },
    finish(outcome: 'success' | 'failed' | 'unknown', source?: string) {
      const totalMs = Math.round(performance.now() - submitted)
      log[outcome === 'failed' || totalMs > 2000 ? 'warn' : 'info']({ clientId, chatId, totalMs, outcome, source }, 'attachment send timing')
    },
  }
}
export type AttachmentSendTiming = ReturnType<typeof attachmentSendTiming>
