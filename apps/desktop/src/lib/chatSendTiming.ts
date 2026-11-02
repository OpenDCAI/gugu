import { rendererLogger } from './log'
export interface ChatSendTiming {
  submit: number
  optimisticAt?: number
  saveStartAt?: number
  chainStartAt?: number
  commitDoneAt?: number
  enqueue?: number
  http?: number
  response?: number
  shown?: number
  ack?: number
}
export const chatSendTimings = new Map<string, ChatSendTiming>()
export function finishChatSendTiming(clientId: string, acked = false): void {
  const t = chatSendTimings.get(clientId)
  if (!t) return
  if (acked && t.shown === undefined) return
  const end = performance.now()
  const ms = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? null : Math.round(b - a)
  const fields = { clientId, submitToEnqueueMs: ms(t.submit, t.enqueue), enqueueToHttpMs: ms(t.enqueue, t.http),
    submitToOptimisticMs: ms(t.submit, t.optimisticAt), optimisticToSaveMs: ms(t.optimisticAt, t.saveStartAt),
    chainWaitMs: ms(t.saveStartAt, t.chainStartAt), commitMs: ms(t.chainStartAt, t.commitDoneAt),
    commitToEnqueueMs: ms(t.commitDoneAt, t.enqueue),
    httpToResponseMs: ms(t.http, t.response), responseToShownMs: ms(t.response, t.shown),
    responseToAckMs: ms(t.response, acked ? t.ack ?? end : undefined), totalMs: ms(t.submit, end) }
  chatSendTimings.delete(clientId)
  rendererLogger('chat/outbox')[end - t.submit > 2000 ? 'warn' : 'info'](fields, 'message send timing')
}
