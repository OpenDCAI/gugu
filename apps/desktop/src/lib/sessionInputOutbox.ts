export type SessionInput = {
  id: string; accountId: string; deviceId: string | null; sessionId: string; text: string; createdAt: number
  attachments?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['attachments']
  error?: string
  /** The send reply arrived; the recorded confirmation may still be in flight. */
  sent?: true
}
export interface SessionInputStorage {
  list(accountId: string): Promise<SessionInput[]>
  put(input: SessionInput): Promise<void>
  remove(accountId: string, id: string): Promise<void>
}

/** Sender-owned requests remain until their transport confirms durable host acceptance. */
export class SessionInputOutbox {
  private flushing: Promise<void> | null = null
  private again = false
  private writing: Promise<unknown> = Promise.resolve()
  constructor(readonly accountId: string, private readonly storage: SessionInputStorage,
    private readonly send: (input: SessionInput) => Promise<void>, private readonly current: () => boolean,
    private readonly changed: () => void = () => {}) {}

  async enqueue(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'attachments'>): Promise<SessionInput> {
    if (!this.current()) throw new Error('Session input account changed')
    return this.write(async () => {
      if (!this.current()) throw new Error('Session input account changed')
      const last = Math.max(0, ...(await this.list()).map(input => input.createdAt))
      const input: SessionInput = { ...target, accountId: this.accountId, id: crypto.randomUUID(), createdAt: Math.max(Date.now(), last + 1) }
      await this.storage.put(input)
      this.changed()
      return input
    })
  }

  async list(): Promise<SessionInput[]> { return (await this.storage.list(this.accountId)).sort((a, b) => a.createdAt - b.createdAt) }

  /** One fact, two adapters: ACP confirms a recorded user row's _meta.clientMessageId;
   * phone Pi confirms the same clientRequestId after accepted:true means its job is persisted. */
  confirm(sessionId: string, clientMessageIds: readonly string[]): Promise<void> {
    return this.write(async () => {
      if (!this.current()) return
      const confirmed = (await this.list()).filter(input => input.sessionId === sessionId && clientMessageIds.includes(input.id))
      for (const input of confirmed) await this.storage.remove(this.accountId, input.id)
      if (confirmed.length) this.changed()
    })
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const written = this.writing.catch(() => undefined).then(operation)
    this.writing = written
    return written
  }

  private update(id: string, patch: Partial<Pick<SessionInput, 'error' | 'sent'>>): Promise<boolean> {
    return this.write(async () => {
      if (!this.current()) return false
      const input = (await this.list()).find(input => input.id === id)
      if (!input) return false // A recorded user row can arrive before the send reply.
      await this.storage.put({ ...input, ...patch })
      this.changed()
      return true
    })
  }

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
    const rows = await this.list()
    for (const input of rows) {
      if (!this.current()) return
      const target = `${input.deviceId ?? 'local'}/${input.sessionId}`
      if (input.sent || blocked.has(target)) continue
      try {
        if (!await this.update(input.id, { error: undefined })) continue
        await withSessionInputDeadline(this.send(input))
        await this.update(input.id, { sent: true, error: undefined })
      } catch (error) {
        blocked.add(target)
        await this.update(input.id, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}

export function confirmedSessionInputIds(turns: readonly import('@gugu/session-core/acp/client').TranscriptTurn[]): string[] {
  return turns.flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user'
    && typeof item._meta?.clientMessageId === 'string' ? [item._meta.clientMessageId] : []))
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
