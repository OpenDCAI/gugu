import { changePhoneConversationQueue } from './phone-conversation-queue.mjs'
import { randomUUID } from 'node:crypto'
import { stableId, uuid } from './phone-agent-store.mjs'

const failure = (code, message) => Object.assign(new Error(message), { code })
const methods = new Set(['prefetchFiles', 'sessionQueue', 'sessionSnapshot', 'sessionAfter', 'sessionOlder', 'sessionToolImage', 'sessionSend', 'sessionRespond', 'sessionOptions', 'sessionSetOption', 'sessionReloadModel'])

/** Task-page methods share the native and remote taskhost.call transport. No DM or workspace
 * pipe is needed; only a Java-originated native UI command may approve a phone operation. */
export function createPhoneTaskApi({ ownerId, store, models, timelines, actions, findSession, verifyAgent, admit, publish, interrupt, turnFiles }) {
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
    const method = channel.replace(/^sessionTimeline\./, '')
    if (!channel.startsWith('sessionTimeline.') || !methods.has(method)) return null
    const input = args[0]
    if (!input || typeof input !== 'object') throw failure('invalid_args', '手机任务请求缺少参数')
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
    } else if (method === 'sessionSend') {
      const files = Array.isArray(input.files) ? input.files : []
      if (typeof input.text !== 'string' || (!input.text.trim() && !files.length)) throw failure('invalid_args', '请先填写任务内容')
      const clientId = input.clientRequestId ? uuid(input.clientRequestId, 'clientRequestId') : requestId ?? randomUUID()
      const id = stableId('phone-task-input', ownerId, agent.sessionId, clientId)
      const fingerprint = stableId('phone-task-input-body', JSON.stringify([input.text.trim(), files.map((file) => [file.itemId, file.version])]))
      const existing = store.state.jobs[id]
      if (existing && existing.inputFingerprint !== fingerprint) throw failure('invalid_args', '同一个发送请求不能更换任务内容，请先重试原消息')
      // Admission keeps the person's words; files are resolved only when this queued job reaches the model.
      await admit({ id, agentUserId: agent.agentUserId, inputFingerprint: fingerprint, prompt: input.text.trim(), ...(files.length ? { files } : {}), route: { kind: 'task', senderUserId: ownerId } })
      value = { accepted: true, messageId: id }
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
