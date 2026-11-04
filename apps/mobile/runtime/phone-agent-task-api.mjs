import { changePhoneConversationQueue } from './phone-conversation-queue.mjs'
import { randomUUID } from 'node:crypto'
import { stableId, uuid } from './phone-agent-store.mjs'
import { SessionInputAdmissionError } from '../../../packages/core/src/shared/sessionInputAdmission.ts'

const failure = (code, message) => new SessionInputAdmissionError(message, 'rejected', code)
const methods = new Set(['prefetchFiles', 'sessionQueue', 'sessionSnapshot', 'sessionAfter', 'sessionOlder', 'sessionToolImage', 'sessionSend', 'sessionRespond', 'sessionOptions', 'sessionSetOption', 'sessionReloadModel'])

/** Task-page methods share the native and remote taskhost.call transport. No DM or workspace
 * pipe is needed; only a Java-originated native UI command may approve a phone operation. */
export function createPhoneTaskApi({ ownerId, store, models, timelines, actions, findSession, verifyAgent, admit, publish, interrupt, turnFiles }) {
  const admitting = new Map()
  const send = async (input, requestId) => {
    const files = Array.isArray(input.files) ? input.files : []
    if (typeof input.text !== 'string' || (!input.text.trim() && !files.length)) throw failure('invalid_args', '请先填写任务内容')
    let clientId, sessionId
    try {
      clientId = input.clientRequestId ? uuid(input.clientRequestId, 'clientRequestId') : requestId ?? randomUUID()
      sessionId = uuid(typeof input.conversationId === 'string' ? input.conversationId.replace(/^session:/, '') : input.conversationId, 'session_id')
    } catch (error) { throw failure('invalid_args', error.message) }
    const id = stableId('phone-task-input', ownerId, sessionId, clientId)
    const fingerprint = stableId('phone-task-input-body', JSON.stringify([input.text.trim(), files.map((file) => [file.itemId, file.version])]))
    const pending = admitting.get(id)
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new SessionInputAdmissionError('原消息尚在确认，不能更换内容', 'uncertain', 'invalid_args')
      return pending.result
    }
    const result = (async () => {
      const existing = store.state.jobs[id]
      if (existing) {
        if (existing.inputFingerprint !== fingerprint) throw new SessionInputAdmissionError('同一个发送请求不能更换任务内容，请先重试原消息', 'uncertain', 'invalid_args')
        // Replays confirm existing custody, even if permission was revoked after a lost ACK.
        // A prior save may have failed after entering memory; acknowledge only after it succeeds.
        await store.save()
      } else {
        const agent = findSession(sessionId)
        await verifyAgent(agent.agentUserId)
        // Keep the person's words; resolve files only when this job reaches the model.
        await admit({ id, agentUserId: agent.agentUserId, inputFingerprint: fingerprint, prompt: input.text.trim(), ...(files.length ? { files } : {}), route: { kind: 'task', senderUserId: ownerId } })
      }
      return { accepted: true, messageId: id, admission: 'accepted' }
    })()
    admitting.set(id, { fingerprint, result })
    try { return await result } finally { admitting.delete(id) }
  }
  const options = async (agent) => {
    const catalog = await models.catalog()
    return { mode: null, effort: null,
      model: { selected: `platform:${agent.modelId}`, available: catalog.map((model) => ({ id: `platform:${model.id}`, name: model.display_name })) },
      modelMenu: { conversationSelection: { modelId: agent.modelId }, agentName: '手机 Agent',
        platformModels: catalog.map((model) => ({ id: model.id, displayName: model.display_name, creditMultiplier: model.credit_multiplier ?? null, contextWindow: model.context_window ?? null, reasoningEfforts: null, requiresMembership: model.requires_membership === true, hidden: model.hidden === true })),
        ownCatalog: null, ownAuth: null,
        liveSetting: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' } } }
  }
  return async (channel, args, requestId, source = { kind: 'device-rpc' }) => {
    if (channel === 'sessions.markSessionSeen') {
      const agent = findSession(args[0])
      await verifyAgent(agent.agentUserId)
      const previous = agent.agentStatusSeen
      agent.agentStatusSeen = 1
      try { await store.save() }
      catch (error) { if (agent.agentStatusSeen === 1) agent.agentStatusSeen = previous; throw error }
      publish()
      return { value: undefined }
    }
    const method = channel.replace(/^sessionTimeline\./, '')
    if (!channel.startsWith('sessionTimeline.') || !methods.has(method)) return null
    const input = args[0]
    if (!input || typeof input !== 'object') throw failure('invalid_args', '手机任务请求缺少参数')
    if (method === 'sessionSend') return { value: await send(input, requestId) }
    const agent = findSession(input.conversationId)
    await verifyAgent(agent.agentUserId)
    let value
    if (method === 'prefetchFiles') value = await turnFiles.prefetch(agent, input.files, source.signal)
    else if (method === 'sessionQueue') value = await changePhoneConversationQueue({ store, agent, action: input.action, interrupt, publish })
    else if (method === 'sessionSnapshot') value = await timelines.snapshot(agent, input)
    else if (method === 'sessionAfter') value = await timelines.after(agent, input)
    else if (method === 'sessionOlder') value = await timelines.older(agent, input)
    else if (method === 'sessionToolImage') value = await timelines.image(agent, input)
    else if (method === 'sessionRespond') {
      await actions().reconcile()
      value = await actions().respond(agent, input, source, admit)
      publish()
    } else if (method === 'sessionOptions') value = await options(agent)
    else {
      if (agent.status === 'working' || Object.values(store.state.jobs).some((job) => job.agentUserId === agent.agentUserId && job.status === 'queued')) throw failure('session_busy', '手机任务正在运行，请结束或取消后再更换模型')
      if (method === 'sessionSetOption' && input.dimension !== 'model') throw failure('unsupported', '手机 Agent 当前只提供模型选择，权限由手机能力授权控制')
      if (method === 'sessionReloadModel' && input.modelSource !== 'platform') throw failure('unsupported', '手机 Agent 当前只支持咕咕平台模型')
      const selected = method === 'sessionSetOption' ? input.value : input.model
      if (typeof selected !== 'string' || !selected) throw failure('invalid_args', '请选择可用的平台模型')
      agent.modelId = await models.resolve(selected.startsWith('platform:') ? selected : `platform:${selected}`)
      await store.save(); publish()
      value = await options(agent)
    }
    return { value }
  }
}
