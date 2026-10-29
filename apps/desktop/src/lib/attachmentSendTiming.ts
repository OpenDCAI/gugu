import { rendererLogger } from './log'
import { i18n } from '../i18n'

export const ATTACHMENT_SEND_DEADLINES = { upload: 120_000, commit: 20_000, readback: 5_000 }
export type AttachmentSendStage = keyof typeof ATTACHMENT_SEND_DEADLINES
const log = rendererLogger('chat/attachments')
export class AttachmentStageTimeout extends Error {
  constructor(readonly stage: AttachmentSendStage) { super(i18n.t('composer.attachmentSendTimedOut', { ns: 'messaging' })) }
}

/** Like chatSendTiming: correlated IDs and elapsed time only, never file contents, URLs or tokens. */
export function attachmentSendTiming(clientId: string, chatId: string) {
  const submitted = performance.now()
  return {
    async stage<T>(stage: AttachmentSendStage, attempt: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
      const started = performance.now(), controller = new AbortController()
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
      const fields = { clientId, chatId, stage, attempt }
      log.info(fields, 'attachment send stage started')
      const timeout = setTimeout(() => controller.abort(new AttachmentStageTimeout(stage)), ATTACHMENT_SEND_DEADLINES[stage])
      let onAbort: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const result = await Promise.race([aborted, Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })])
        const elapsedMs = Math.round(performance.now() - started)
        log[elapsedMs > 2000 ? 'warn' : 'info']({ ...fields, elapsedMs, outcome: 'success' }, 'attachment send stage timing')
        return result
      } catch (error) {
        log[signal.aborted && !(error instanceof AttachmentStageTimeout) ? 'info' : 'warn']({ ...fields, elapsedMs: Math.round(performance.now() - started), outcome: error instanceof AttachmentStageTimeout ? 'timeout' : signal.aborted ? 'cancelled' : 'failed' }, 'attachment send stage timing')
        throw error
      } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', onAbort)
      }
    },
    finish(outcome: 'success' | 'failed', source?: string) {
      const totalMs = Math.round(performance.now() - submitted)
      log[outcome === 'failed' || totalMs > 2000 ? 'warn' : 'info']({ clientId, chatId, totalMs, outcome, source }, 'attachment send timing')
    },
  }
}
export type AttachmentSendTiming = ReturnType<typeof attachmentSendTiming>
