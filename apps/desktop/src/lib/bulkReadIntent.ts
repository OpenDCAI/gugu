type Queue = { version: number; retained: number; pending: Set<Promise<void>>; barrier: Promise<void> }
type Queues = Map<string, Queue>
const fallback: Queues = new Map()
const KEY = '__GUGU_BULK_READ_INTENTS__' as const
function queues(): Queues {
  if (typeof window === 'undefined') return fallback
  const host = window as Window & { [KEY]?: Queues }
  return host[KEY] ??= new Map()
}
function queueFor(id: string): Queue {
  const all = queues()
  let queue = all.get(id)
  if (!queue) { queue = { version: 0, retained: 0, pending: new Set(), barrier: Promise.resolve() }; all.set(id, queue) }
  return queue
}
function prune(id: string, queue: Queue): void {
  if (!queue.pending.size && !queue.retained && queues().get(id) === queue) queues().delete(id)
}
function track(id: string, queue: Queue, work: Promise<void>): Promise<void> {
  queue.pending.add(work)
  const done = () => { queue.pending.delete(work); prune(id, queue) }
  void work.then(done, done)
  return work
}

/** Retain only the chats in this click. A later manual unread supersedes every pending batch. */
export function captureBulkReadIntent(ids: readonly string[]) {
  const captured = new Map([...new Set(ids)].map(id => {
    const queue = queueFor(id)
    queue.retained += 1
    return [id, { queue, version: queue.version }] as const
  }))
  return {
    run(id: string, action: () => Promise<void>): Promise<void> {
      const token = captured.get(id)!
      return track(id, token.queue, token.queue.barrier.then(async () => { if (token.version === token.queue.version) await action() }))
    },
    release(): void {
      for (const [id, { queue }] of captured) { queue.retained -= 1; prune(id, queue) }
      captured.clear()
    },
  }
}

/** The explicit unread is written after already-sent reads; reads not yet sent are cancelled. */
export function manualUnreadAfterBulkReads(id: string, action: () => Promise<void>): Promise<void> {
  const queue = queueFor(id)
  queue.version += 1
  const work = Promise.allSettled([...queue.pending]).then(action)
  queue.barrier = work.then(() => {}, () => {})
  return track(id, queue, work)
}
