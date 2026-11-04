import { lifeHoldIsFailure, type LifeView } from '@/session/shared/core/sessions/session-life'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { sessionInputAdmission, type SessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission'
import { rendererLogger } from './log'
import { createIndexedDbHandle } from './indexedDbHandle'
import { translateSessionMessage } from '@renderer/localization/locale-store'
export type SessionInput = {
  id: string; accountId: string; deviceId: string | null; sessionId: string; text: string; createdAt: number
  attachments?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['attachments']
  files?: import('@gugu/session-core/session-record/contract').TurnFileRef[]
  failure?: SessionInputFailure
  /** Only the receiving boundary can stop automatic recovery. Missing on legacy stored rows. */
  admission?: Exclude<SessionInputAdmission, 'accepted'>
  /** Presentation only: an explicitly queued input remains in the composer queue. */
  queued?: boolean
  /** Composer-owned, not yet sent. Legacy/mobile `queued` alone is only presentation. */
  sendQueue?: { order: number; afterInputId?: string; edit?: { draftText: string; originalDraftText: string } }
  baseline?: string[]
  afterTurnId?: string
  /** Explicit send-now insertion, never used by automatic queue release. */
  steerIfBusy?: true
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
  /** The person stopped the session before it went: it goes with their next message. */
  | { state: 'stopped' }
  /** The durable sender still owns this input and will automatically retry it. */
  | { state: 'waiting'; failure: SessionInputFailure }
  /** The host owns a failed row, or explicitly refused to take the sender's input. */
  | { state: 'failed'; failure: SessionInputFailure | null; hostReason: string | null }
  | { state: 'unknown' })

/**
 * Custody of a messageId has one owner at a time: the transcript once the host row is accepted, else the host row,
 * else the sender row. A bubble is drawn from whichever owns it; the transcript draws its own.
 */
export function sessionInputBubbles(sender: readonly SessionInput[], host: readonly HostPendingRow[], hold: LifeView['hold']): SessionInputBubble[] {
  const hosted = new Set(host.map(row => row.messageId))
  return [
    // Every pending row, whatever wrote it (the person, another task, the inbox): one projection of the queue.
    ...[...host].sort((a, b) => a.seq - b.seq).flatMap((row): SessionInputBubble[] => {
      const delivered = readDeliveryEnvelope(row.text)
      const base = delivered ? { id: row.messageId, text: delivered.body, from: delivered.segments[0]?.facts?.from ?? null } : { id: row.messageId, text: row.text }
      switch (row.state) {
        case 'accepted': return []
        case 'queued': case 'dispatching':
          if (hold === 'user-stop') return [{ ...base, state: 'stopped' }]
          return [lifeHoldIsFailure(hold) ? { ...base, state: 'failed', failure: null, hostReason: null } : { ...base, state: 'sending' }]
        case 'failed': return [{ ...base, state: 'failed', failure: null, hostReason: row.failure }]
        case 'unknown': return [{ ...base, state: 'unknown' }]
      }
    }),
    ...[...sender].filter(input => !hosted.has(input.id)).sort((a, b) => a.createdAt - b.createdAt)
      .map((input): SessionInputBubble => ({ id: input.id, text: input.text,
        ...(input.admission === 'rejected' ? { state: 'failed', failure: input.failure ?? null, hostReason: null }
          : input.failure ? { state: 'waiting', failure: input.failure } : { state: 'sending' }) })),
  ]
}

/** A queued file sent to an old host keeps its caption and explains what was omitted. */
export function withoutQueuedAttachments(input: SessionInput, count: number): SessionInput {
  const { files: _files, failure: _failure, ...body } = input
  return { ...body, text: [input.text, translateSessionMessage('composer.attachmentsNotSent', { count })].filter(Boolean).join('\n\n') }
}
export interface SessionInputStorage {
  list(accountId: string): Promise<SessionInput[]>
  put(input: SessionInput): Promise<void>
  remove(accountId: string, id: string): Promise<void>
  writeBatch?(accountId: string, puts: readonly SessionInput[], removes: readonly string[]): Promise<void>
}

/** Sender-owned durable requests. Only a host acceptance removes a request; reconnects reuse its identity. */
export class SessionInputOutbox {
  private flushing: Promise<void> | null = null
  private again = false
  private retryFailures = false
  private writing: Promise<unknown> = Promise.resolve()
  private readonly generations = new Map<string, object>()
  constructor(readonly accountId: string, private readonly storage: SessionInputStorage,
    private readonly send: (input: SessionInput) => Promise<void>, private readonly current: () => boolean,
    private readonly changed: () => void = () => {},
    private readonly beforeEnqueue: (input: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files' | 'attachments'>) => void = () => {}) {}

  async enqueue(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files' | 'attachments' | 'queued' | 'baseline' | 'afterTurnId' | 'sendQueue'> & { composer?: true }): Promise<SessionInput> {
    if (!this.current()) throw new Error('Session input account changed')
    const written = this.writing.catch(() => undefined).then(async () => {
      if (!this.current()) throw new Error('Session input account changed')
      this.beforeEnqueue(target)
      const rows = await this.list()
      const last = Math.max(0, ...rows.map(input => input.createdAt))
      const at = Math.max(Date.now(), last + 1)
      const { composer, ...body } = target
      const previous = rows.filter(row => row.sessionId === target.sessionId && row.deviceId === target.deviceId && row.admission !== 'rejected')
      const afterInputId = previous.find(row => !row.sendQueue)?.id ?? previous.find(row => row.sendQueue)?.sendQueue?.afterInputId
      const sendQueue = target.sendQueue ?? (composer && previous.length ? { order: at, ...(afterInputId ? { afterInputId } : {}) } : undefined)
      const input: SessionInput = { ...body, ...(sendQueue ? { queued: true, sendQueue: { ...sendQueue, order: at } } : {}),
        accountId: this.accountId, id: crypto.randomUUID(), createdAt: at }
      await this.storage.put(input)
      this.changed()
      return input
    })
    this.writing = written
    return written
  }

  list(): Promise<SessionInput[]> { return this.storage.list(this.accountId) }

  /** A rejected input has never been handed over. Only this person's explicit action releases it. */
  async retry(id: string): Promise<void> {
    await this.changeRejected(id, input => {
      const { failure: _failure, admission: _admission, ...body } = input
      return body
    })
    await this.flush()
  }

  async edit(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('Session input is empty')
    await this.changeRejected(id, input => ({ ...input, text }))
  }

  async discard(id: string): Promise<void> { await this.changeRejected(id, () => null) }

  private async changeRejected(id: string, change: (input: SessionInput) => SessionInput | null): Promise<void> {
    await this.flushing
    const written = this.writing.catch(() => undefined).then(async () => {
      if (!this.current()) throw new Error('Session input account changed')
      const input = (await this.list()).find(row => row.id === id)
      if (!input || input.admission !== 'rejected') throw new Error('Session input is not awaiting a manual decision')
      const next = change(input)
      this.generations.delete(id)
      if (next) await this.storage.put(next)
      else {
        const following = (await this.list()).filter(row => row.sendQueue?.afterInputId === id).map(row => {
          const { afterInputId: _after, ...sendQueue } = row.sendQueue!
          return { ...row, sendQueue }
        })
        await this.persist(following, [id])
      }
      this.changed()
    })
    this.writing = written
    await written
  }

  /** Queue edits and release share the enqueue lane: a deleted/edited input cannot race into send. */
  private write<T>(operation: () => Promise<T>): Promise<T> {
    const written = this.writing.catch(() => undefined).then(async () => {
      if (!this.current()) throw new Error('Session input account changed')
      return operation()
    })
    this.writing = written
    return written
  }

  private async persist(puts: readonly SessionInput[], removes: readonly string[] = []): Promise<void> {
    if (this.storage.writeBatch) return this.storage.writeBatch(this.accountId, puts, removes)
    for (const input of puts) await this.storage.put(input)
    for (const id of removes) await this.storage.remove(this.accountId, id)
  }

  changeQueued(id: string, change: { text: string; edit?: { draftText: string; originalDraftText: string } | null } | 'delete'): Promise<boolean> {
    return this.write(async () => {
      const input = (await this.list()).find(row => row.id === id && row.sendQueue)
      if (!input) return false
      if (change === 'delete') await this.storage.remove(this.accountId, id)
      else await this.storage.put({ ...input, text: change.text, sendQueue: { ...input.sendQueue!,
        ...(change.edit === undefined ? {} : { edit: change.edit ?? undefined }) } })
      this.changed()
      return true
    })
  }

  reorderQueued(sessionId: string, ids: readonly string[]): Promise<void> {
    return this.write(async () => {
      const inputs = (await this.list()).filter(row => row.sessionId === sessionId && row.sendQueue)
        .sort((a, b) => a.sendQueue!.order - b.sendQueue!.order)
      if (ids.length !== inputs.length || new Set(ids).size !== ids.length || ids.some(id => !inputs.some(input => input.id === id))) {
        throw new Error('Send queue identities changed; reload its order')
      }
      const reordered = ids.map((id, index) => {
        const input = inputs.find(row => row.id === id)!
        return { ...input, sendQueue: { ...input.sendQueue!, order: inputs[index]!.sendQueue!.order } }
      })
      await this.persist(reordered)
      this.changed()
    })
  }

  /** One foreground completion releases one input, never all of a session's queue. */
  releaseQueued(sessionId: string, baseline: Pick<SessionInput, 'baseline' | 'afterTurnId'>,
    completed: ReadonlySet<string>, nowId?: string, steers = false, canRelease: () => boolean = () => true): Promise<SessionInput | null> {
    return this.write(async () => {
      const rows = (await this.list()).filter(row => row.sessionId === sessionId)
      if (!canRelease() || (!nowId && rows.some(row => !row.sendQueue && row.admission !== 'rejected'))) return null
      const queued = rows.filter(row => row.sendQueue).sort((a, b) => a.sendQueue!.order - b.sendQueue!.order)
      const input = nowId ? queued.find(row => row.id === nowId) : queued[0]
      const predecessor = input?.sendQueue?.afterInputId
      if (!input || input.sendQueue!.edit || (!nowId && predecessor && !completed.has(predecessor)
        && !rows.some(row => row.id === predecessor && row.admission === 'rejected'))) return null
      // Remaining entries wait for this exact input to finish, including across a shell restart.
      const following = queued.filter(row => row.id !== input.id).map(row => ({ ...row, sendQueue: { ...row.sendQueue!, afterInputId: input.id } }))
      const { sendQueue: _queue, ...released } = input
      const sent: SessionInput = { ...released, ...baseline, queued: false, ...(steers ? { steerIfBusy: true } : {}) }
      await this.persist([...following, sent])
      this.changed()
      return sent
    })
  }

  flush(retryFailures = false): Promise<void> {
    this.retryFailures ||= retryFailures
    if (this.flushing) { this.again = true; return this.flushing }
    this.flushing = this.drainUntilCurrent().finally(() => { this.flushing = null })
    return this.flushing
  }

  private async drainUntilCurrent(): Promise<void> {
    do {
      this.again = false
      const retryFailures = this.retryFailures
      this.retryFailures = false
      await this.drain(retryFailures)
    } while (this.again && this.current())
  }

  private async drain(retryFailures: boolean): Promise<void> {
    const blocked = new Set<string>()
    const rows = (await this.list()).sort((a, b) => a.createdAt - b.createdAt)
    for (const input of rows) {
      if (!this.current()) return
      if (input.sendQueue) continue
      const target = `${input.deviceId ?? 'local'}/${input.sessionId}`
      // A definitive refusal belongs to the person, including after reopening the application.
      // It does not prevent independent, later inputs for this target from being admitted.
      if (input.admission === 'rejected') continue
      if (blocked.has(target)) continue
      const prepared = this.writing.catch(() => undefined).then(async () => {
        if (!this.current()) return null
        const live = (await this.list()).find(row => row.id === input.id)
        if (!live || live.sendQueue || live.admission === 'rejected') return null
        if (live.failure && retryFailures) {
          delete live.failure
          await this.storage.put(live)
          this.changed()
        }
        const attempt = this.generations.get(live.id) ?? {}
        this.generations.set(live.id, attempt)
        // Starting a replay and applying a late decision share the same write order.
        let sending: Promise<void>
        try { sending = this.send(live) } catch (error) { sending = Promise.reject(error) }
        return { attempt, sending }
      })
      this.writing = prepared
      const ready = await prepared
      if (!ready) continue
      const { attempt } = ready
      // All automatic replays share an admission generation. Manual decisions invalidate its late results.
      // The display deadline releases this drain, not the receiving boundary's eventual decision.
      const sending = ready.sending.then(
        () => this.settleAttempt(input.id, attempt, { ok: true }),
        async error => { await this.settleAttempt(input.id, attempt, { ok: false, error }); throw error },
      )
      try { await withSessionInputDeadline(sending) }
      catch (error) {
        if (sessionInputAdmission(error) !== 'accepted') blocked.add(target)
        await this.settleAttempt(input.id, attempt, { ok: false, error })
      }
      this.changed()
    }
  }

  private async settleAttempt(id: string, attempt: object, outcome: { ok: true } | { ok: false; error: unknown }): Promise<void> {
    const written = this.writing.catch(() => undefined).then(async () => {
      if (!this.current() || this.generations.get(id) !== attempt) return
      const input = (await this.list()).find(row => row.id === id)
      if (!input) return
      const error = outcome.ok ? undefined : outcome.error
      const admission = outcome.ok ? 'accepted' : sessionInputAdmission(error)
      // Another automatic attempt may already have taken custody before this refusal arrived.
      // Only that affirmative receipt can settle a refusal; manual actions invalidate the generation.
      if (input.admission === 'rejected' && admission !== 'accepted') return
      if (admission === 'accepted') await this.storage.remove(this.accountId, id)
      else {
        rendererLogger('session/input-outbox').warn({ deviceId: input.deviceId, sessionId: input.sessionId, error: String(error), admission }, 'Native input not delivered; it stays queued')
        await this.storage.put({ ...input, admission, failure: error instanceof SessionInputFailureError ? error.failure
          : { code: 'send-failed', message: error instanceof Error ? error.message : String(error) } })
      }
      if (admission === 'accepted') this.generations.delete(id)
      this.changed()
    })
    this.writing = written
    await written
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
  const handle = createIndexedDbHandle(() => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('gugu.session-input-outbox.v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('inputs', { keyPath: ['accountId', 'id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
  await handle.get()
  const mutate = async (run: (store: IDBObjectStore) => void) => {
    const db = await handle.get()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('inputs', 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Session input persistence aborted'))
      tx.onerror = () => reject(tx.error)
      run(tx.objectStore('inputs'))
    })
  }
  return {
    list: async accountId => {
      const db = await handle.get()
      return new Promise<SessionInput[]>((resolve, reject) => {
        const request = db.transaction('inputs').objectStore('inputs').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))
        request.onsuccess = () => resolve(request.result as SessionInput[])
        request.onerror = () => reject(request.error)
      })
    },
    put: input => mutate(store => { store.put(input) }),
    remove: (accountId, id) => mutate(store => { store.delete([accountId, id]) }),
    writeBatch: (accountId, puts, removes) => mutate(store => {
      for (const input of puts) store.put(input)
      for (const id of removes) store.delete([accountId, id])
    }),
  }
}
