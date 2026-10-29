import { readdir, stat, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createPiJsonlSource } from '../../../packages/session-core/src/session-record/sources/pi-jsonl.ts'
import { createSessionTimeline } from '../../../packages/session-core/src/session-record/timeline.ts'
import { findToolImage } from '../../../packages/session-core/src/session-record/tool-image.ts'
import { trimAfterResultForTransport, trimOlderForTransport, trimSnapshotForTransport } from '../../../packages/session-core/src/session-record/transport-trim.ts'
import { createPhoneLiveProjection } from './phone-agent-live.mjs'

const failure = (code, message) => Object.assign(new Error(message), { code })
const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted'])
const permissionCodes = new Set(['revoked', 'not_granted', 'os_permission'])
const hiddenNotice = '手机数据授权已改变，旧记录已隐藏。可以发送新的任务。'
const timestamp = (value) => { const at = Date.parse(value); return Number.isFinite(at) ? at : undefined }
const message = (key, at, text, role = 'user') => ({ key, ...(at === undefined ? {} : { at }), event: { kind: 'message', role, messageId: key, text } })

/** Decode Pi's actual JSONL with the existing source/reducer. The host journal supplies only
 * admitted inputs and real failures before Pi could open a record, plus interrupted boundaries. */
export function createPhoneTimelineRuntime({ root, store, authorize, confirmations = () => [] }) {
  const open = new Map()
  const hidden = new Map()
  const opening = new Map()
  const live = createPhoneLiveProjection()
  const denied = new WeakSet()
  let closed = false
  const checkAuthorization = async (agent) => {
    try { await authorize(agent) }
    catch (error) {
      // Only an explicit authorization failure may hide records; never mask source/IO errors.
      if (permissionCodes.has(error?.code)) denied.add(error)
      throw error
    }
  }
  const jobsOf = (agent) => Object.values(store.state.jobs).filter((job) => job.agentUserId === agent.agentUserId && (!job.contextEpoch || job.contextEpoch === agent.contextEpoch)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const directoryOf = (agent) => agent.contextEpoch ? join(root, agent.sessionId, agent.contextEpoch, 'sessions') : join(root, agent.sessionId, 'sessions')
  const recordOf = async (agent) => {
    const directory = directoryOf(agent)
    let path = agent.record?.contextEpoch === agent.contextEpoch ? agent.record.path : null
    if (!path) {
      let files
      try { files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort() } catch (error) { if (error.code !== 'ENOENT') throw error; files = [] }
      path = files.length ? join(directory, files.at(-1)) : null
    }
    if (!path) return null
    const part = relative(directory, path)
    if (!part || part.startsWith('..') || isAbsolute(part)) throw failure('record_unreadable', '手机会话记录不属于这条任务')
    try {
      const resolved = await realpath(path)
      const base = await realpath(directory)
      const inside = relative(base, resolved)
      if (inside.startsWith('..') || isAbsolute(inside) || !(await stat(resolved)).isFile()) throw failure('record_unreadable', '手机会话记录路径无效')
      return resolved
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
  }
  const hostEntries = (agent, piEntries) => jobsOf(agent).flatMap((job) => {
    if (job.status === 'queued') return []
    const began = timestamp(job.startedAt ?? job.createdAt)
    const ended = timestamp(job.finishedAt ?? job.startedAt ?? job.createdAt)
    const recorded = piEntries.some((entry) => entry.event?.kind === 'message' && entry.event.role === 'user' && (entry.at ?? 0) >= (began ?? 0) && (entry.event.text === job.prompt || entry.event.text.startsWith(`${job.prompt}\n\n手机宿主已根据真实主人确认`)))
    const entries = []
    // A queued/failed admission is a real user input, not an invented empty transcript.
    if (!recorded && job.status !== 'done') entries.push(message(`phone-input:${job.id}`, began, job.prompt))
    if (terminal.has(job.status) && job.status !== 'done') {
      if (!recorded) entries.push(message(`phone-failure:${job.id}`, ended, job.error ?? '手机任务已取消', 'assistant'))
      entries.push({ key: `phone-boundary:${job.id}`, at: ended, boundary: { kind: job.status === 'cancelled' ? 'turn_aborted' : 'turn_failed' } })
    }
    entries.push(...(job.runtimeNotices ?? []).map((notice) => ({ key: notice.key, at: notice.at, event: { kind: 'session_notice', code: 'provider-notice', title: notice.title, detail: notice.description ?? notice.title } })))
    return entries
  })
  const sourceFor = (agent, path) => {
    let sink
    let piEntries = []
    let published = []
    let starting = false
    let pi = null
    const materialize = () => {
      if (!sink || starting) return
      const projected = live.project(agent, piEntries)
      const host = [...hostEntries(agent, piEntries), ...projected.pending].map((entry, order) => ({ entry, order })).sort((a, b) => (a.entry.at ?? 0) - (b.entry.at ?? 0) || a.order - b.order).map(({ entry }) => entry)
      const merged = []
      let index = 0
      for (const entry of projected.base) {
        while (index < host.length && (host[index].at ?? 0) < (entry.at ?? 0)) merged.push(host[index++])
        merged.push(entry)
      }
      merged.push(...host.slice(index))
      const prefix = published.length <= merged.length && published.every((entry, i) => JSON.stringify(entry) === JSON.stringify(merged[i]))
      if (!prefix) { sink.onReset('source_replaced'); published = [] }
      const changed = merged.slice(published.length)
      published = merged
      if (changed.length) sink.onEntries(changed)
    }
    return {
      locator: { harness: 'pi', providerSessionId: path ?? agent.sessionId, roots: [directoryOf(agent)] },
      async start(events) {
        sink = events; starting = true
        if (path) {
          pi = createPiJsonlSource({ harness: 'pi', providerSessionId: path, roots: [directoryOf(agent)] })
          await pi.start({ onEntries: (entries) => { piEntries.push(...entries); materialize() }, onReset: (reason) => { piEntries = []; published = []; sink.onReset(reason) } })
        }
        starting = false; materialize()
      },
      async catchUp() { await pi?.catchUp(); materialize() },
      stop() { pi?.stop(); sink = null },
    }
  }
  const load = async (agent) => {
    if (closed) throw failure('host_not_ready', '手机宿主已停止')
    await checkAuthorization(agent)
    hidden.get(agent.sessionId)?.timeline.dispose(); hidden.delete(agent.sessionId)
    const path = await recordOf(agent)
    if (!path && jobsOf(agent).some((job) => job.status === 'done')) throw failure('record_unreadable', '这条手机任务记录暂时无法读取，请重试；不会用摘要冒充完整转录')
    const key = `${agent.contextEpoch ?? 'legacy'}:${path ?? 'admitted'}`
    let cached = open.get(agent.sessionId)
    if (cached?.key !== key) {
      cached?.timeline.dispose()
      let settlementAt = null
      const timeline = await createSessionTimeline(sourceFor(agent, path), { sessionId: agent.sessionId, now: () => settlementAt ?? Date.now() })
      if (closed) { timeline.dispose(); throw failure('host_not_ready', '手机宿主已停止') }
      cached = { key, timeline, settle: (settlement) => {
        settlementAt = settlement.resolvedAt
        try { timeline.settle({ itemId: settlement.itemId, optionId: settlement.optionId, by: settlement.resolvedBy }) } finally { settlementAt = null }
      } }; open.set(agent.sessionId, cached)
    }
    await cached.timeline.catchUp()
    const pending = confirmations(agent)
    const asRequest = ({ itemId, kind, title, detail, options }) => ({ itemId, kind, title, detail, options })
    cached.timeline.syncPendingRequests(pending.map(asRequest))
    for (const settlement of pending) if (settlement.state === 'resolved') cached.settle(settlement)
    cached.timeline.syncPendingRequests(pending.filter((settlement) => settlement.state !== 'cancelled').map(asRequest))
    cached.timeline.syncQueuedPrompts(jobsOf(agent).filter((job) => job.status === 'queued').map((job) => ({ id: job.id, text: job.prompt })))
    return cached.timeline
  }
  const serialized = async (agent, work) => {
    // File discovery/source installation is serialized per session so simultaneous polls cannot
    // install two file watchers or answer with two unrelated epochs.
    const before = opening.get(agent.sessionId) ?? Promise.resolve()
    const pending = before.catch(() => undefined).then(work)
    opening.set(agent.sessionId, pending)
    try { return await pending } finally { if (opening.get(agent.sessionId) === pending) opening.delete(agent.sessionId) }
  }
  const timeline = (agent) => serialized(agent, () => load(agent))
  const hiddenTimeline = (agent) => serialized(agent, async () => {
    if (closed) throw failure('host_not_ready', '手机宿主已停止')
    open.get(agent.sessionId)?.timeline.dispose(); open.delete(agent.sessionId); live.reset(agent.sessionId)
    const key = agent.contextEpoch ?? 'legacy'
    let cached = hidden.get(agent.sessionId)
    if (cached?.key !== key) {
      cached?.timeline.dispose()
      const at = Date.now()
      const safe = await createSessionTimeline({
        locator: { harness: 'pi', providerSessionId: 'phone-permission-hidden', roots: [] },
        async start(events) {
          events.onEntries([
            { key: 'phone-permission-hidden:notice', at, event: { kind: 'session_notice', code: 'provider-notice', title: hiddenNotice, detail: hiddenNotice } },
            { key: 'phone-permission-hidden:end', at, boundary: { kind: 'turn_end', stopReason: 'end_turn' } },
          ])
        },
        async catchUp() {}, stop() {},
      }, { sessionId: `phone-permission-hidden:${agent.sessionId}` })
      if (closed) { safe.dispose(); throw failure('host_not_ready', '手机宿主已停止') }
      cached = { key, timeline: safe }; hidden.set(agent.sessionId, cached)
    }
    return cached.timeline
  })
  const deliver = async (agent, read) => {
    const epoch = agent.contextEpoch
    const value = read(await timeline(agent))
    // File IO can overlap revocation or a new permission epoch. The check before opening a
    // record alone cannot authorize handing its contents back after those asynchronous reads.
    await checkAuthorization(agent)
    if (agent.contextEpoch !== epoch) throw failure('record_unreadable', '手机任务上下文已更新，请重新读取时间线')
    return value
  }
  const readable = async (agent, read) => {
    try { return await deliver(agent, read) }
    catch (error) {
      if (!denied.has(error)) throw error
      return read(await hiddenTimeline(agent))
    }
  }
  const pageSize = (input) => { if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw failure('invalid_args', '手机任务读取轮数必须是正整数') }
  return {
    live(agent, job, event) { if (!closed) live.accept(agent, job, event) },
    async finish(agent, job) { await open.get(agent.sessionId)?.timeline.catchUp(); live.finish(agent, job) },
    reset(sessionId) { live.reset(sessionId); open.get(sessionId)?.timeline.dispose(); open.delete(sessionId); hidden.get(sessionId)?.timeline.dispose(); hidden.delete(sessionId) },
    async snapshot(agent, input) { pageSize(input); return readable(agent, (read) => { const result = read.getSnapshot({ limit: input.limit }); return input.trim ? trimSnapshotForTransport(result) : result }) },
    async after(agent, input) { if (!input.cursor || typeof input.cursor.epoch !== 'string' || !Number.isSafeInteger(input.cursor.seq) || input.cursor.seq < 0) throw failure('invalid_args', '手机任务时间线游标无效'); return readable(agent, (read) => { const result = read.getAfter(input.cursor); return input.trim ? trimAfterResultForTransport(result) : result }) },
    async older(agent, input) { pageSize(input); if (typeof input.beforeTurnId !== 'string') throw failure('invalid_args', '请指定要往前读取的任务轮次'); return readable(agent, (read) => { const result = read.getOlder(input); return input.trim ? trimOlderForTransport(result) : result }) },
    async image(agent, input) { return deliver(agent, (read) => { const found = findToolImage(read.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns, input.itemId, input.index); if (!found.ok) throw failure(found.code, found.code === 'too_large' ? '这张工具图片超过单次读取大小限制' : '这条手机任务记录中没有指定的工具图片'); return found.image }) },
    async close() { closed = true; await Promise.allSettled([...opening.values()]); for (const { timeline } of [...open.values(), ...hidden.values()]) timeline.dispose(); open.clear(); hidden.clear(); live.clear() },
  }
}
