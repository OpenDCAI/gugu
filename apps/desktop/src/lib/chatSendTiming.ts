import { rendererLogger } from './log'
export const chatSendTimings = new Map<string, { submit: number; enqueue?: number; http?: number; response?: number }>()
export function finishChatSendTiming(clientId: string, acked = false): void {
  const t = chatSendTimings.get(clientId)
  if (!t) return
  const end = performance.now()
  const ms = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? null : Math.round(b - a)
  const fields = { clientId, submitToEnqueueMs: ms(t.submit, t.enqueue), enqueueToHttpMs: ms(t.enqueue, t.http),
    httpToResponseMs: ms(t.http, t.response), responseToAckMs: ms(t.response, acked ? end : undefined), totalMs: ms(t.submit, end) }
  chatSendTimings.delete(clientId)
  rendererLogger('chat/outbox')[end - t.submit > 2000 ? 'warn' : 'info'](fields, 'message send timing')
}
