import { subagentUpdate } from '../../../../packages/core/src/shared/subagentUpdates.mjs'

const terminalState = (status) => ({ completed: 'completed', failed: 'failed', errored: 'failed', interrupted: 'cancelled', shutdown: 'cancelled', notFound: 'disconnected' })[status]

// A child's prompt is its task, not its name: keep the list label short (a real nickname from thread/started overrides it).
const shortName = (prompt) => { const line = (prompt ?? '').trim().split('\n')[0]; return line.length > 30 ? `${line.slice(0, 30)}…` : line || undefined }

/** Consumes the official app-server's child-thread events. No provider fork or additional agent process. */
export function createCodexSubagents({ rootId, emit, request, itemTool, reasoningText }) {
  const children = new Map()
  const pendingThreads = new Map()
  const streamed = new Map()
  const finished = new Set()

  const state = (id, value, extra = {}) => emit(subagentUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: id, state: value, ...extra }))
  const stream = (id, update) => emit(subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: id, update }))

  function register(id, parent, info = {}) {
    if (!id || id === rootId() || (parent !== rootId() && !children.has(parent))) return
    const previous = children.get(id)
    const child = { ...previous, id, parent, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) }
    children.set(id, child)
    emit(subagentUpdate({
      sessionUpdate: 'subagent_spawned', subagentSessionId: id, background: true,
      name: child.name, task: child.task, model: child.model, request: child.request,
      launchToolCallId: child.launchToolCallId,
      ...(parent !== rootId() ? { parentToolCallId: parent } : {}),
      capabilities: { cancel: Boolean(child.turnId) },
    }))
    for (const [pendingId, thread] of pendingThreads) {
      if (thread.parent === id) { pendingThreads.delete(pendingId); register(pendingId, id, thread.info) }
    }
    return child
  }

  function activity(parent, item, reportState = true) {
    if (item.type === 'subAgentActivity') {
      const id = item.agentThreadId
      const child = children.get(id) ?? register(id, parent, { name: item.agentPath, launchToolCallId: item.id })
      if (!child) return false
      if (reportState && item.kind === 'completed') state(id, 'completed')
      if (reportState && item.kind === 'interrupted') state(id, 'cancelled')
      return true
    }
    if (item.type !== 'collabAgentToolCall') return false
    for (const id of item.receiverThreadIds ?? []) {
      const child = children.get(id) ?? register(id, parent, {
        name: shortName(item.prompt), task: item.prompt, model: item.model,
        request: item.prompt, launchToolCallId: item.id,
      })
      if (!child) continue
      const reported = item.agentsStates?.[id]
      const outcome = terminalState(reported?.status)
      if (reportState && outcome) state(id, outcome, { summary: reported.message })
    }
    return true
  }

  function wholeItem(id, item, completed, replaying = false) {
    if (activity(id, item, !replaying)) return
    const key = `${id}:${item.id}`
    if (completed && finished.has(key)) return
    if (completed) finished.add(key)
    if (completed && !streamed.has(key)) {
      if (item.type === 'agentMessage' && item.text) stream(id, { sessionUpdate: 'agent_message_chunk', messageId: item.id, content: { type: 'text', text: item.text } })
      if (item.type === 'reasoning') {
        const text = reasoningText(item.summary ?? [], item.content ?? [])
        if (text) stream(id, { sessionUpdate: 'agent_thought_chunk', messageId: item.id, content: { type: 'text', text } })
      }
    }
    const tool = itemTool(item)
    if (tool) stream(id, {
      sessionUpdate: completed ? 'tool_call_update' : 'tool_call', toolCallId: item.id,
      status: completed ? item.status === 'failed' ? 'failed' : 'completed' : 'in_progress', ...tool,
    })
  }

  function onNotification(message) {
    const { method, params = {} } = message
    if (method === 'thread/started') {
      const thread = params.thread ?? {}
      const source = thread.source?.subAgent?.thread_spawn
      if (!source?.parent_thread_id) return false
      const info = { name: source.agent_path ?? thread.agentNickname ?? thread.agentRole }
      if (!register(thread.id, source.parent_thread_id, info)) pendingThreads.set(thread.id, { parent: source.parent_thread_id, info })
      return true
    }
    const id = params.threadId
    if (id !== rootId() && !children.has(id)) return false
    if ((method === 'item/started' || method === 'item/completed') && activity(id, params.item ?? {})) return true
    if (id === rootId()) return false
    const child = children.get(id)
    if (method === 'turn/started') {
      child.turnId = params.turn?.id
      state(id, 'running', { canCancel: Boolean(child.turnId) })
    } else if (method === 'turn/completed') {
      child.turnId = undefined
      const outcome = terminalState(params.turn?.status)
      if (outcome) state(id, outcome, { summary: params.turn?.error?.message })
    } else if (method === 'thread/status/changed' && params.status?.type === 'systemError') {
      child.turnId = undefined
      state(id, 'failed')
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const key = `${id}:${params.itemId}`
      const part = params.summaryIndex ?? params.contentIndex ?? 0
      const previous = streamed.get(key)
      streamed.set(key, part)
      stream(id, {
        sessionUpdate: method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
        messageId: params.itemId,
        content: { type: 'text', text: `${previous !== undefined && previous !== part ? '\n\n' : ''}${params.delta ?? ''}` },
      })
    } else if (method === 'item/started' || method === 'item/completed') {
      wholeItem(id, params.item ?? {}, method === 'item/completed')
    }
    // Child configuration, usage, compaction and other lifecycle events never mutate the parent's state.
    return true
  }

  return {
    onNotification,
    // Relationships come from the parent; each child's own turns supply its history and lifecycle.
    replayItem: (item) => activity(rootId(), item, false),
    async replayChildren(deadline = Date.now() + 15_000) {
      for (const child of children.values()) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('Codex child history read exceeded the session load deadline')
        const result = await request('thread/read', { threadId: child.id, includeTurns: true }, remaining)
        if (!result.thread) throw new Error(`Codex child history ${child.id} returned no thread`)
        for (const turn of result.thread?.turns ?? []) {
          state(child.id, 'running', { canCancel: false })
          for (const item of turn.items ?? []) wholeItem(child.id, item, true, true)
          const outcome = terminalState(turn.status)
          if (outcome) state(child.id, outcome)
          else if (turn.status === 'inProgress') { child.turnId = turn.id; state(child.id, 'running', { canCancel: true }) }
        }
      }
    },
    async stop(id) {
      const child = children.get(id)
      if (!child?.turnId) throw new Error(`Codex child ${id} has no running turn to interrupt`)
      await request('turn/interrupt', { threadId: id, turnId: child.turnId })
    },
  }
}
