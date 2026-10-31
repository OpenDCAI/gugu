import { toolCallStart, toolCallResult } from '../../../packages/session-core/src/session-record/sources/shared.ts'

const textUpdate = (kind, id, text) => kind === 'thinking' ? { kind: 'thinking', messageId: id, text } : { kind: 'message', role: 'assistant', messageId: id, text }
const blocksOf = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []).filter((block) => block?.type === 'text' || block?.type === 'image')

/** Pi's public message_end notification precedes its synchronous appendMessage. Resolve the
 * source entry on the next microtask by object identity, never by a guessed text/timestamp. */
export function createPhonePiObserver({ jobId, sessionManager, emit }) {
  let count = 0
  let current = null
  const messages = new WeakMap()
  const live = (event) => emit({ type: 'pi_live', ...event })
  const committed = (message, id) => queueMicrotask(() => {
    const leaf = sessionManager.getLeafEntry()
    const entry = leaf?.type === 'message' && leaf.message === message ? leaf : sessionManager.getEntries().findLast((candidate) => candidate.type === 'message' && candidate.message === message)
    if (entry) live({ kind: 'committed', id, recordId: entry.id })
  })
  const notice = (code, title, description) => emit({ type: 'runtime_notice', code, title, description, at: Date.now() })
  return (event) => {
    if (event.type === 'agent_start') live({ kind: 'phase', phase: 'model' })
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      current = `phone-live:${jobId}:${++count}`
      messages.set(event.message, current)
      live({ kind: 'message', id: current, at: event.message.timestamp ?? Date.now() })
    }
    if (event.type === 'message_update' && current) {
      const delta = event.assistantMessageEvent
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') live({ kind: 'delta', id: current, index: delta.contentIndex, textKind: delta.type === 'thinking_delta' ? 'thinking' : 'text', text: delta.delta })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const id = messages.get(event.message) ?? current
      if (id) { live({ kind: 'complete', id, at: event.message.timestamp, content: event.message.content }); committed(event.message, id) }
      current = null
    }
    if (event.type === 'message_end' && event.message.role === 'toolResult') {
      const id = `phone-result:${jobId}:${event.message.toolCallId}`
      live({ kind: 'result', id, toolCallId: event.message.toolCallId, at: event.message.timestamp, content: blocksOf(event.message.content), isError: event.message.isError === true })
      committed(event.message, id)
    }
    if (event.type === 'tool_execution_start' && !event.parentToolCallId) live({ kind: 'tool', toolCallId: event.toolCallId, name: event.toolName, args: event.args, at: Date.now() })
    if (event.type === 'tool_execution_start') live({ kind: 'phase', phase: 'tool' })
    if (event.type === 'tool_execution_end') live({ kind: 'phase', phase: 'model' })
    if (event.type === 'compaction_start') notice('compaction_start', '正在整理上下文', event.reason === 'overflow' ? '模型上下文已满，Pi 正在压缩后继续。' : 'Pi 正在整理较早的上下文，保留最近对话。')
    if (event.type === 'compaction_end') notice('compaction_end', event.aborted ? '上下文整理已取消' : event.result ? '上下文已整理' : '上下文整理未完成', event.willRetry ? 'Pi 将继续当前任务。' : '这次上下文整理已结束。')
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') notice('retry_start', event.type === 'auto_retry_start' ? '模型请求正在重试' : '上下文整理请求正在重试', `第 ${event.attempt}/${event.maxAttempts} 次，等待 ${event.delayMs} 毫秒。`)
    if (event.type === 'auto_retry_end') notice('retry_end', event.success ? '模型请求已恢复' : '模型重试未恢复', `Pi 已结束第 ${event.attempt} 次重试。`)
  }
}

/** A live overlay is still RecordEntry → the same shared reducer/cursor. Once Pi's source
 * entry arrives, recreate the original chunk keys from its authoritative text and keep only
 * lengths/IDs in memory. Normal disk handoff therefore neither repeats text nor changes IDs. */
export function createPhoneLiveProjection() {
  const sessions = new Map()
  const stateOf = (agent) => {
    let state = sessions.get(agent.sessionId)
    if (state?.epoch !== agent.contextEpoch) { state = { epoch: agent.contextEpoch, groups: new Map(), tools: new Map(), sequence: 0 }; sessions.set(agent.sessionId, state) }
    return state
  }
  const tool = (state, job, call, name, args, at) => {
    if (state.tools.has(call)) return
    state.tools.set(call, { jobId: job.id, key: `phone-tool:${job.id}:${call}`, at, event: toolCallStart(call, name, 'other', args) })
  }
  return {
    accept(agent, job, event) {
      if (job.status !== 'running' || job.contextEpoch !== agent.contextEpoch) return
      const state = stateOf(agent)
      if (event.kind === 'message') state.groups.set(event.id, { jobId: job.id, id: event.id, at: event.at, blocks: new Map(), order: state.sequence++ })
      const group = state.groups.get(event.id)
      if (event.kind === 'delta' && group && typeof event.text === 'string') {
        const index = Number.isSafeInteger(event.index) ? event.index : 0
        let block = group.blocks.get(index)
        if (!block) { block = { kind: event.textKind, parts: [] }; group.blocks.set(index, block) }
        block.parts.push({ key: `${event.id}#${index}:${block.parts.length}`, text: event.text, length: event.text.length })
      }
      if (event.kind === 'complete' && group) {
        for (const [index, block] of (event.content ?? []).entries()) {
          if (block.type === 'text' || block.type === 'thinking') {
            const text = block.type === 'text' ? block.text : block.thinking
            const previous = group.blocks.get(index)
            if (!previous || previous.parts.map((part) => part.text ?? '').join('') !== text) group.blocks.set(index, { kind: block.type, parts: text ? [{ key: `${event.id}#${index}:final`, text, length: text.length }] : [] })
          }
          if (block.type === 'toolCall') tool(state, job, block.id, block.name, block.arguments, group.at)
        }
      }
      if (event.kind === 'tool') tool(state, job, event.toolCallId, event.name, event.args, event.at)
      if (event.kind === 'result') state.groups.set(event.id, { jobId: job.id, id: event.id, at: event.at, order: state.sequence++, result: toolCallResult(event.toolCallId, event.isError ? 'failed' : 'completed', { text: event.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'), images: event.content.filter((block) => block.type === 'image') }) })
      if (event.kind === 'committed' && group) group.recordId = event.recordId
    },
    project(agent, entries) {
      const state = stateOf(agent)
      const mapped = new Map([...state.groups.values()].filter((group) => group.recordId).map((group) => [group.recordId, group]))
      const found = new Set()
      const toolFound = new Set()
      const base = entries.flatMap((entry) => {
        if (entry.event?.kind === 'tool_call' && state.tools.has(entry.event.toolCallId)) {
          const draft = state.tools.get(entry.event.toolCallId)
          toolFound.add(entry.event.toolCallId)
          return [{ ...entry, key: draft.key, at: draft.at }]
        }
        const match = /^pi:([^#]+)#(\d+)$/.exec(entry.key)
        const group = match ? mapped.get(match[1]) : null
        if (!group) return [entry]
        found.add(group.id)
        if (group.result) { group.result = null; return [{ ...entry, key: `${group.id}:result`, at: group.at }] }
        if (!group.blocks) return [{ ...entry, key: `${group.id}:result`, at: group.at }]
        const block = group.blocks.get(Number(match[2]))
        if (!block || !['message', 'thinking'].includes(entry.event?.kind)) return [entry]
        const text = entry.event.text
        let offset = 0
        const result = block.parts.map((part) => { const value = { key: part.key, at: group.at, event: textUpdate(block.kind, `${group.id}#${match[2]}`, text.slice(offset, offset + part.length)) }; offset += part.length; delete part.text; return value })
        if (offset < text.length) result.push({ key: `${group.id}#${match[2]}:tail`, at: group.at, event: textUpdate(block.kind, `${group.id}#${match[2]}`, text.slice(offset)) })
        return result
      })
      const pending = []
      for (const group of state.groups.values()) {
        if (found.has(group.id)) continue
        if (group.result) pending.push({ key: `${group.id}:result`, at: group.at, event: group.result })
        for (const [index, block] of group.blocks ?? []) for (const part of block.parts) if (part.text !== undefined) pending.push({ key: part.key, at: group.at, event: textUpdate(block.kind, `${group.id}#${index}`, part.text) })
      }
      for (const [id, draft] of state.tools) if (!toolFound.has(id) && draft.event) pending.push({ key: draft.key, at: draft.at, event: draft.event })
      return { base, pending }
    },
    finish(agent, job) {
      const state = stateOf(agent)
      for (const [id, group] of state.groups) if (group.jobId === job.id) {
        if (!group.recordId) state.groups.delete(id)
        else { for (const block of group.blocks?.values() ?? []) for (const part of block.parts) delete part.text; group.result = null }
      }
      for (const draft of state.tools.values()) if (draft.jobId === job.id) draft.event = null
    },
    reset(sessionId) { sessions.delete(sessionId) },
    clear() { sessions.clear() },
  }
}
