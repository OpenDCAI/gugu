import { randomUUID } from 'node:crypto'

const MAX_CONNECTIONS = 64
const MAX_PER_PAGE = 16
const fields = {
  open: ['type', 'requestId', 'sourceId'],
  answer: ['type', 'id', 'sdp'],
  close: ['type', 'id'],
}
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const parse = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !fields[raw.type]
    || Object.keys(raw).some(key => !fields[raw.type].includes(key))) throw new Error('Invalid projection signaling message')
  if (raw.type === 'open' ? !text(raw.requestId) || !text(raw.sourceId) : !text(raw.id)) throw new Error('Invalid projection signaling handle')
  if (raw.type === 'answer' && (raw.sdp?.type !== 'answer' || typeof raw.sdp.sdp !== 'string' || raw.sdp.sdp.length > 128 * 1024
    || Object.keys(raw.sdp).some(key => key !== 'type' && key !== 'sdp'))) throw new Error('Invalid projection answer')
  return structuredClone(raw)
}
const errorOf = value => value instanceof Error ? value : new Error(String(value))
const same = (a, b) => a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.appId === b.appId
  && a.sessionId === b.sessionId && a.pageId === b.pageId && a.epoch === b.epoch
const validContext = context => context && ['ownerId', 'deviceId', 'appId', 'sessionId', 'pageId', 'epoch'].every(key => text(context[key]))

/**
 * One host's signaling lifetime. Context is stamped by an authenticated host
 * page binding; it is never decoded from an App's arguments or an SDP message.
 * The mandatory lease resolves the actual local resource and rechecks its grant.
 * This class registers no RPC or App API by itself.
 */
export class ProjectionSignals {
  #entries = new Map()
  #requests = new Map()
  #disposed = false
  constructor({ authorize, openMedia }) { this.authorize = authorize; this.openMedia = openMedia }

  async receive(context, raw) {
    if (this.#disposed || !validContext(context)) throw new Error('Projection signaling context is closed')
    context = Object.freeze({ ...context })
    const command = parse(raw)
    if (command.type === 'open') return this.#open(context, command)
    const entry = this.#entries.get(command.id)
    if (!entry || !same(context, entry.context)) throw new Error('Projection signaling is not in this App task binding')
    if (command.type === 'close') { await this.#close(entry); return }
    entry.abort.signal.throwIfAborted()
    if (entry.answering) throw new Error('Projection answer was already submitted')
    entry.answering = true
    try {
      await entry.opened
      await entry.lease.assertCurrent()
      entry.abort.signal.throwIfAborted()
      await entry.media.answer(command.sdp)
      entry.abort.signal.throwIfAborted()
      await entry.lease.assertCurrent()
      clearTimeout(entry.timer)
      entry.connected = true
      return { id: entry.id }
    } catch (error) { await this.#close(entry).catch(() => undefined); throw error }
  }

  async #open(context, command) {
    const key = JSON.stringify([context.ownerId, context.deviceId, context.appId, context.sessionId, context.pageId, context.epoch, command.requestId])
    const first = this.#requests.get(key)
    if (first) {
      if (first.sourceId !== command.sourceId) throw new Error('Projection request id was reused for another source')
      await first.opened
      await first.lease.assertCurrent()
      first.abort.signal.throwIfAborted()
      return { id: first.id, offer: first.media.offer }
    }
    const own = [...this.#entries.values()].filter(entry => same(context, entry.context)).length
    if (this.#entries.size >= MAX_CONNECTIONS || own >= MAX_PER_PAGE) throw new Error('Too many direct projection connections')
    const entry = { id: randomUUID(), key, context, sourceId: command.sourceId, abort: new AbortController(),
      connected: false, answering: false, queue: Promise.resolve(), queued: 0 }
    this.#entries.set(entry.id, entry)
    this.#requests.set(key, entry)
    // A handshake is bounded. A connected projection has the task/grant's life,
    // never an idle-viewer timer.
    entry.timer = setTimeout(() => { void this.#close(entry).catch(() => undefined) }, 30000)
    entry.timer.unref()
    entry.opened = (async () => {
      const lease = await this.authorize(context, command.sourceId, entry.abort.signal)
      entry.lease = lease
      if (!same(context, lease.context) || lease.sourceId !== command.sourceId) throw new Error('Projection authority does not match its host binding')
      const abort = () => { void this.#close(entry).catch(() => undefined) }
      entry.off = () => lease.signal.removeEventListener('abort', abort)
      lease.signal.addEventListener('abort', abort, { once: true })
      if (lease.signal.aborted) abort()
      await lease.assertCurrent()
      entry.abort.signal.throwIfAborted()
      entry.media = await this.openMedia(lease, entry.abort.signal, data => this.#control(entry, data))
      void entry.media.closed.then(abort, abort)
      entry.abort.signal.throwIfAborted()
      await lease.assertCurrent()
    })()
    try {
      await entry.opened
      return { id: entry.id, offer: entry.media.offer }
    } catch (error) {
      await this.#close(entry).catch(() => undefined)
      throw error
    }
  }

  #control(entry, data) {
    if (entry.abort.signal.aborted) return
    // The helper may deliver control immediately before its ready receipt. Its
    // answer is already being checked; queued work rechecks the lease at use.
    if (!entry.answering || entry.queued >= 64) { void this.#close(entry).catch(() => undefined); return }
    entry.queued++
    const work = entry.queue.then(async () => {
      entry.abort.signal.throwIfAborted()
      await entry.lease.assertCurrent()
      entry.abort.signal.throwIfAborted()
      // Only the owning resource driver can produce an execution result.
      const result = await entry.lease.receive(data, entry.abort.signal)
      entry.abort.signal.throwIfAborted()
      await entry.lease.assertCurrent()
      if (result !== undefined) await entry.media.sendControl(result)
    }).finally(() => { entry.queued-- })
    entry.queue = work.catch(() => { void this.#close(entry).catch(() => undefined) })
  }

  #close(entry) {
    if (entry.closing) return entry.closing
    let resolve, reject
    entry.closing = new Promise((yes, no) => { resolve = yes; reject = no })
    void entry.closing.catch(() => undefined)
    entry.abort.abort(new Error('Projection signaling binding closed'))
    clearTimeout(entry.timer)
    void (async () => {
      await entry.opened.catch(() => undefined)
      entry.off?.()
      // The media helper owns no input driver. Drain/cancel the owning App's
      // input and disconnect it before releasing that App resource lease.
      const results = await Promise.allSettled([entry.queue])
      try {
        await entry.lease?.disconnect()
      } finally {
        try { await entry.media?.close() }
        catch (error) { if (error !== entry.abort.signal.reason) throw error }
        finally { entry.lease?.release() }
      }
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected) throw errorOf(rejected.reason)
    })().finally(() => {
      // Still count draining/closing children: repeatedly opening and closing
      // must not create unbounded processes while an old driver is stalled.
      this.#entries.delete(entry.id)
      if (this.#requests.get(entry.key) === entry) this.#requests.delete(entry.key)
    }).then(resolve, reject)
    return entry.closing
  }

  /** A real page retarget, account change or task close calls this synchronously. */
  async closeBinding(context) {
    const results = await Promise.allSettled([...this.#entries.values()].filter(entry => same(context, entry.context)).map(entry => this.#close(entry)))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  async dispose() {
    this.#disposed = true
    const results = await Promise.allSettled([...this.#entries.values()].map(entry => this.#close(entry)))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }
}
