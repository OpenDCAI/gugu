import { AssistantPanelError } from './assistantPanel'

export const ASSISTANT_PANEL_READ_TIMEOUT_MS = 15_000

/** Snapshot facts change through publication, not through retries. */
export function isAssistantPanelReadRetryable(error: unknown): boolean {
  if (!error) return true
  const { code,status,name,message } = error as { code?: string; status?: number; name?: string; message?: string }
  if (code) return ['read-timeout','transport-failed','unavailable','PGRST003'].includes(code) || /^08/.test(code) || /^5\d{2}$/.test(code)
  return (status !== undefined && status >= 500) || ['AbortError','TimeoutError','NetworkError'].includes(name ?? '')
    || name === 'TypeError' && /fetch|network|load failed/i.test(message ?? '')
}

export const retryAssistantPanelRead = (count: number, error: unknown) => count < 2 && isAssistantPanelReadRetryable(error)

/** Read-only shell operations may accept this signal to cancel their transport.
 * A late result cannot turn the timed-out read into a successful one. */
export async function withAssistantPanelReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      new Promise<never>((_resolve,reject) => {
        timer = setTimeout(() => {
          const error = new AssistantPanelError('read-timeout','PANEL_READ_TIMEOUT')
          controller.abort(error); reject(error)
        },ASSISTANT_PANEL_READ_TIMEOUT_MS)
      }),
    ])
  } finally { clearTimeout(timer) }
}
