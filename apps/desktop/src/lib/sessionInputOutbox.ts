export type SessionInput = {
  id: string; accountId: string; deviceId: string | null; sessionId: string; text: string; createdAt: number
  /**
   * The turn's attachments: DM-folder file references (P3). A row an older client stored may still carry `attachments`
   * (ACP upload refs the host no longer takes): it is sent without them, its text intact.
   */
  files?: import('@gugu/session-core/session-record/contract').TurnFileRef[]
  error?: string
}
export interface SessionInputStorage {
  list(accountId: string): Promise<SessionInput[]>
  put(input: SessionInput): Promise<void>
  remove(accountId: string, id: string): Promise<void>
}

/** Sender-owned durable requests. Only a host acceptance removes a request; reconnects reuse its identity. */
export class SessionInputOutbox {
  private flushing: Promise<void> | null = null
  private again = false
  private writing: Promise<unknown> = Promise.resolve()
  constructor(readonly accountId: string, private readonly storage: SessionInputStorage,
    private readonly send: (input: SessionInput) => Promise<void>, private readonly current: () => boolean,
    private readonly changed: () => void = () => {}) {}

  async enqueue(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files'>): Promise<SessionInput> {
    if (!this.current()) throw new Error('Session input account changed')
    const written = this.writing.catch(() => undefined).then(async () => {
      if (!this.current()) throw new Error('Session input account changed')
      const last = Math.max(0, ...(await this.list()).map(input => input.createdAt))
      const input: SessionInput = { ...target, accountId: this.accountId, id: crypto.randomUUID(), createdAt: Math.max(Date.now(), last + 1) }
      await this.storage.put(input)
      this.changed()
      return input
    })
    this.writing = written
    return written
  }

  list(): Promise<SessionInput[]> { return this.storage.list(this.accountId) }

  flush(): Promise<void> {
    if (this.flushing) { this.again = true; return this.flushing }
    this.flushing = this.drainUntilCurrent().finally(() => { this.flushing = null })
    return this.flushing
  }

  private async drainUntilCurrent(): Promise<void> {
    do { this.again = false; await this.drain() } while (this.again && this.current())
  }

  private async drain(): Promise<void> {
    const blocked = new Set<string>()
    const rows = (await this.list()).sort((a, b) => a.createdAt - b.createdAt)
    for (const input of rows) {
      if (!this.current()) return
      const target = `${input.deviceId ?? 'local'}/${input.sessionId}`
      if (blocked.has(target)) continue
      try {
        await withSessionInputDeadline(this.send(input))
        await this.storage.remove(this.accountId, input.id)
      } catch (error) {
        blocked.add(target)
        await this.storage.put({ ...input, error: error instanceof Error ? error.message : String(error) })
      }
      this.changed()
    }
  }
}

/** A lost response leaves the same request queued; it never allocates another native input id. */
export async function withSessionInputDeadline<T>(operation: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native session input acknowledgement timed out')), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** A separate durable store: IM cache recovery must never discard unsent native inputs. */
export async function openSessionInputStorage(factory: IDBFactory = indexedDB): Promise<SessionInputStorage> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('gugu.session-input-outbox.v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('inputs', { keyPath: ['accountId', 'id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const mutate = (run: (store: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction('inputs', 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Session input persistence aborted'))
    tx.onerror = () => reject(tx.error)
    run(tx.objectStore('inputs'))
  })
  return {
    list: accountId => new Promise((resolve, reject) => {
      const request = db.transaction('inputs').objectStore('inputs').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))
      request.onsuccess = () => resolve(request.result as SessionInput[])
      request.onerror = () => reject(request.error)
    }),
    put: input => mutate(store => { store.put(input) }),
    remove: (accountId, id) => mutate(store => { store.delete([accountId, id]) }),
  }
}
