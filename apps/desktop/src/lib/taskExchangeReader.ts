import type { TaskExchange, TaskExchangePage, TaskExchangeRequest } from '../session/shared/core/sessions/task-collaboration'

export type TaskExchangeTransport = {
  read(request: TaskExchangeRequest): Promise<TaskExchangePage>
  subscribe(request: TaskExchangeRequest & { subscriptionId: string }): Promise<TaskExchangePage>
  unsubscribe(subscriptionId: string): Promise<unknown>
  onPage(subscriptionId: string, receive: (page: TaskExchangePage) => void): () => void
  onLink?(changed: (open: boolean) => void): () => void
}

/** Subscribe before reading, deduplicate by durable id, and resume after a broken host connection. */
export function startTaskExchangeReader(
  transport: TaskExchangeTransport,
  request: TaskExchangeRequest,
  receive: (entries: TaskExchange[]) => void,
  /** `unavailable` 带上为什么(读失败的原文;连接断了 = 无),由调用方记日志 —— ❌ 吞掉只剩一句「读不到」。 */
  state: (value: 'loading' | 'ready' | 'unavailable', error?: unknown) => void,
): () => void {
  let disposed = false
  let generation = 0
  let offPage: (() => void) | undefined
  let subscriptionId: string | undefined
  let cursor = 0
  // An unavailable native bridge may throw before it returns a Promise. Cleanup must handle both paths.
  const unsubscribe = (id: string) => { void Promise.resolve().then(() => transport.unsubscribe(id)).catch(() => undefined) }
  const stop = () => {
    offPage?.()
    offPage = undefined
    const id = subscriptionId
    subscriptionId = undefined
    if (id) unsubscribe(id)
  }
  const start = async () => {
    const run = ++generation
    stop()
    const id = crypto.randomUUID()
    subscriptionId = id
    state('loading')
    const current = () => !disposed && run === generation
    offPage = transport.onPage(id, (page) => { if (current()) receive(page.entries) })
    try {
      let page = await transport.subscribe({ ...request, after: cursor, subscriptionId: id })
      if (!current()) { unsubscribe(id); return }
      for (;;) {
        receive(page.entries)
        cursor = page.cursor
        if (!page.hasMore) break
        page = await transport.read({ ...request, after: cursor })
        if (!current()) return
      }
      state('ready')
    } catch (error) {
      if (current()) { stop(); state('unavailable', error) }
    }
  }
  const offLink = transport.onLink?.((open) => {
    if (disposed) return
    if (open) void start()
    else { generation++; stop(); state('unavailable') }
  })
  void start()
  return () => { disposed = true; generation++; offLink?.(); stop() }
}
