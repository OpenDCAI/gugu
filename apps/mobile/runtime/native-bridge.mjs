import { randomUUID } from 'node:crypto'

/** Correlation lives in this process; unknown and late responses cannot complete another tool. */
export function createNativeBridge(emit, { timeoutMs = 30_000 } = {}) {
  const pending = new Map()
  const call = (name, args, signal, context = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('任务已取消')); return }
    const id = randomUUID()
    const settle = (error, result) => {
      if (!pending.delete(id)) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => settle(signal.reason ?? new Error('任务已取消'))
    const timer = setTimeout(() => settle(Object.assign(new Error('手机工具没有在时限内返回'), name === 'phone.native' ? { code: 'execution_unknown' } : {})), name === 'phone.native' ? Math.max(timeoutMs, 180_000) : timeoutMs)
    timer.unref?.()
    pending.set(id, { settle, context, name })
    signal?.addEventListener('abort', abort, { once: true })
    emit({ type: 'native_tool', id, name, args, ...context })
  })
  return {
    call,
    resolve(command) {
      const task = pending.get(command.id)
      if (!task) return false
      if (command.ownerId && task.context.ownerId && command.ownerId !== task.context.ownerId) return false
      if (command.sessionId && task.context.sessionId && command.sessionId !== task.context.sessionId) return false
      task.settle(null, command.result)
      return true
    },
    close() { for (const task of [...pending.values()]) task.settle(Object.assign(new Error('手机运行时已关闭'), task.name === 'phone.native' ? { code: 'execution_unknown' } : {})) },
  }
}
