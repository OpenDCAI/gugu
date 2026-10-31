import { coreLogger, type CoreLogFields } from '../../log'

const log = coreLogger('attachment-download')

/** Preserve network cause codes (fetch often only reports "fetch failed" at the top level). */
export function attachmentFailureReason(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  for (let cause = error; cause !== undefined && !seen.has(cause);) {
    seen.add(cause)
    parts.push(cause instanceof Error ? `${cause.message}${'code' in cause ? ` (${cause.code})` : ''}` : String(cause))
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return parts.length ? parts.join(': ') : String(error)
}

export async function attachmentStage<T>(context: CoreLogFields, stage: string, action: () => Promise<T>): Promise<T> {
  const start = Date.now()
  try {
    const value = await action()
    log.info({ ...context, stage, elapsedMs: Date.now() - start }, 'attachment stage completed')
    return value
  } catch (error) {
    log.warn({ ...context, stage, elapsedMs: Date.now() - start, err: attachmentFailureReason(error) }, 'attachment stage failed')
    throw error
  }
}
