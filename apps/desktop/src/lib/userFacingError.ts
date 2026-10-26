import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'

/** The existing UI error boundary preserves the cause and removes sensitive text. */
export function messageForUser(error: unknown): string {
  return safeFailureLine(String((error as Error)?.message ?? error))
}
