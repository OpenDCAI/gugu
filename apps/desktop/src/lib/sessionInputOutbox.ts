import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
export type SessionInput = {
  id: string; accountId: string; deviceId: string | null; sessionId: string; text: string; createdAt: number
  attachments?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['attachments']
  failure?: SessionInputFailure
}
/** Failures the sender itself names; any other send error keeps the host's own words. */
export type SessionInputFailure =
  | { code: 'host-offline' }
  | { code: 'host-not-ready' }
  | { code: 'phone-unconfirmed' }
  | { code: 'no-acknowledgement' }
  | { code: 'send-failed'; message: string }
export class SessionInputFailureError extends Error {
  constructor(readonly failure: Exclude<SessionInputFailure, { code: 'send-failed' }>) { super(failure.code) }
}
/** A host session_pending row as its LifeView shows it. */
export type HostPendingRow = LifeView['pending']['items'][number]
/** from: a delivery (another task's or agent's message) shows its sender and body, read the way the transcript reads it. */
export type SessionInputBubble = { id: string; text: string; from?: string | null } & (
  | { state: 'sending' }
  /** The host holds it while its session is failed: it goes when the person retries (or sends again). */
  | { state: 'held' }
  /** failure: the sender named it (retry re-sends its copy); hostReason: the host row failed, in the host's words. */
  | { state: 'failed'; failure: SessionInputFailure | null; hostReason: string | null }
  | { state: 'unknown' })

/**
 * Custody of a messageId has one owner at a time: the transcript once the host row is accepted, else the host row,
 * else the sender row. A bubble is drawn from whichever owns it; the transcript draws its own.
 */
export function sessionInputBubbles(sender: readonly SessionInput[], host: readonly HostPendingRow[], lifeKind: LifeView['kind'] | null): SessionInputBubble[] {
  const hosted = new Set(host.map(row => row.messageId))
  return [
    // An inbox batch is the agent's mail, not the person's input: the transcript shows it once the agent takes it.
    ...[...host].filter(row => row.kind !== 'inbox-batch').sort((a, b) => a.seq - b.seq).flatMap((row): SessionInputBubble[] => {
      const delivered = readDeliveryEnvelope(row.text)
      const base = delivered ? { id: row.messageId, text: delivered.body, from: delivered.segments[0]?.facts?.from ?? null } : { id: row.messageId, text: row.text }
      switch (row.state) {
        case 'accepted': return []
        case 'queued': case 'dispatching': return [{ ...base, state: lifeKind === 'failed' ? 'held' : 'sending' }]
        case 'failed': return [{ ...base, state: 'failed', failure: null, hostReason: row.failure }]
        case 'unknown': return [{ ...base, state: 'unknown' }]
      }
    }),
    ...[...sender].filter(input => !hosted.has(input.id)).sort((a, b) => a.createdAt - b.createdAt)
      .map((input): SessionInputBubble => ({ id: input.id, text: input.text,
        ...(input.failure ? { state: 'failed', failure: input.failure, hostReason: null } : { state: 'sending' }) })),
  ]
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

  async enqueue(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'attachments'>): Promise<SessionInput> {
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
        await this.storage.put({ ...input, failure: error instanceof SessionInputFailureError ? error.failure
          : { code: 'send-failed', message: error instanceof Error ? error.message : String(error) } })
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
      timer = setTimeout(() => reject(new SessionInputFailureError({ code: 'no-acknowledgement' })), timeoutMs)
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
