import { randomUUID } from 'node:crypto'

const personal = (store, job) => job.route?.kind === 'task' && job.route.senderUserId === store.state.ownerId
const visibleContent = content => Array.isArray(content) && content.some(block => block?.type === 'image' || (block?.type === 'text' && block.text?.trim() && block.text.trim() !== '[NO_REPLY]'))

// Called only at live admission, never while opening a journal or reading a transcript.
// The caller saves message + publication together before acknowledging or making an RPC.
function admitMessage(store, job, agent, deviceId, key, message) {
  const messages = job.personalMessages ??= {}
  if (messages[key]) return messages[key]
  if (!deviceId || !agent?.sessionId || !agent.chatId || agent.agentUserId !== job.agentUserId) throw new Error('personal publication requires its phone Agent and DM binding')
  const entry = { id: randomUUID(), deviceId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, chatId: agent.chatId, occurredAt: message.occurredAt }
  if (!Number.isFinite(Date.parse(entry.occurredAt))) throw new Error('personal publication requires the original message time')
  messages[key] = { ...message, publicationId: entry.id, aliases: [] }
  const outbox = store.state.conversationOutbox ??= {}
  outbox[entry.id] = { ...entry, status: 'pending', role: message.role, jobId: job.id }
  return messages[key]
}

export function admitPhonePersonalInput(store, job, { agent, deviceId }) {
  if (!personal(store, job)) return
  admitMessage(store, job, agent, deviceId, 'input', { role: 'user', text: job.prompt, ...(job.files?.length ? { files: structuredClone(job.files) } : {}), occurredAt: job.createdAt })
}

/** A completed live message is the first durable reply content in the host journal. Its
 * publication UUID is independent of the runtime counter and later Pi record aliases. */
export function recordPhonePersonalReply(store, job, agent, deviceId, event) {
  if (!personal(store, job) || job.status !== 'running') return false
  if (event.kind === 'complete' && visibleContent(event.content)) {
    if (typeof event.id !== 'string' || !event.id) throw new Error('live reply has no message identity')
    const occurredAt = new Date(event.at).toISOString()
    admitMessage(store, job, agent, deviceId, event.id, { role: 'assistant', content: structuredClone(event.content.filter(block => block.type === 'text' || block.type === 'image')), occurredAt })
    return true
  }
  if (event.kind === 'committed') {
    const message = job.personalMessages?.[event.id === `phone-input:${job.id}` ? 'input' : event.id]
    if (message && typeof event.recordId === 'string' && !message.aliases.includes(event.recordId)) { message.aliases.push(event.recordId); return true }
  }
  return false
}

/** A separate queue from message_send: only metadata is published, never transcript bodies.
 * Save again before every request, including recovery from an earlier failed admission save. */
export function createPhoneConversationPublisher({ store, cloud, isReady, authorize, warn, retryMs = 30_000 }) {
  let closed = false, flight = null, rerun = false, timer = null
  const current = () => !closed && isReady()
  const retry = () => {
    if (closed || timer) return
    timer = setTimeout(() => { timer = null; void publisher.kick() }, retryMs)
    timer.unref?.()
  }
  const run = async () => {
    const attempted = new Set()
    do {
      rerun = false
      for (const entry of Object.values(store.state.conversationOutbox ?? {})) {
        if (!current()) return
        if (entry.status !== 'pending' || attempted.has(entry.id)) continue
        attempted.add(entry.id)
        try {
          await store.save()
          if (!current()) return
          if (entry.role === 'assistant') {
            const job = store.state.jobs[entry.jobId]
            if (!job) throw new Error('personal reply publication has no durable message job')
            await authorize(job.usedGroups ?? [], { sessionId: entry.sessionId, permissionRequirements: job.permissionRequirements })
          }
          if (!current()) return
          const receipt = await cloud.rpc('chat', 'publish_native_conversation_message', {
            p_device_id: entry.deviceId, p_agent_user_id: entry.agentUserId, p_session_id: entry.sessionId,
            p_message_id: entry.id, p_chat_id: entry.chatId, p_occurred_at: entry.occurredAt,
          })
          if (receipt?.chat_id !== entry.chatId || typeof receipt.already !== 'boolean' || typeof receipt.account_revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(receipt.account_revision)) throw new Error('invalid personal conversation publication receipt')
          entry.status = 'published'; entry.receipt = receipt; delete entry.errorCode
          await store.save()
        } catch (error) {
          entry.status = 'pending'
          delete entry.receipt
          entry.errorCode = error.code ?? 'publication_unavailable'
          warn({ code: entry.errorCode, messageId: entry.id })
          retry()
          // A revoked/removed Agent must not block another task's later real message.
          // Each pending item is attempted at most once in this pump invocation.
        }
      }
    } while (rerun && current())
  }
  const publisher = {
    kick() {
      if (!current()) return Promise.resolve()
      if (flight) { rerun = true; return flight }
      clearTimeout(timer); timer = null
      flight = run().finally(() => { flight = null; if (rerun && !timer && current()) void publisher.kick() })
      return flight
    },
    close() { closed = true; clearTimeout(timer); timer = null; return flight ?? Promise.resolve() },
  }
  return publisher
}
