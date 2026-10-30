import { assistantWorkIntentSchema } from '../../../packages/core/src/shared/assistantWorkIntent.ts'
import { randomUUID } from 'node:crypto'
import { buildSessionDirectEnvelope, formatDeliveryTimestamp } from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import { stableId, uuid } from './phone-agent-store.mjs'

const first = (data) => Array.isArray(data) ? data[0] : data
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required'); return value.trim() }

/** Both native and cloud creation drive this one durable provisioning saga and birth-group contract. */
export function createPhoneProvisioner({ ownerId, cloud, store, deviceId, projectId, root, models, tick, admit, snapshot, publish }) {
  const provisioning = new Map()
  const provisionOnce = async (requestId, action, caller = null, inputDataProof = null) => {
    const intent=action.assistant_work ? assistantWorkIntentSchema.parse(action.assistant_work) : null
    if(intent && (!caller || caller.sessionId!==intent.coordinator.session_id || caller.deviceId!==intent.coordinator.device_id)) throw new Error('Assistant work coordinator does not match the phone caller')
    let request = store.state.requests[requestId]
    try {
      const harness = action.harness ?? 'pi'
      if (harness !== 'pi') throw new Error('这台手机只提供 pi，请显式传 harness:"pi"')
      if (action.transport && action.transport !== 'acp') throw new Error('手机 Agent 只提供通用会话，不提供终端会话')
      if (action.sessionView && action.sessionView !== 'general') throw new Error('手机 Agent 只提供通用会话')
      if (action.permissionMode || action.effort) throw new Error('手机 Agent 尚未提供权限模式和思考档位选择')
      if ((action.project_id && action.project_id !== projectId) || (action.projectId && action.projectId !== projectId) || (action.project_path && action.project_path !== root) || (action.projectPath && action.projectPath !== root)) throw new Error('手机 Agent 只能在这台手机的 App 私有工作目录中运行')
      const prompt = required(action.prompt, 'prompt')
      const requestedGroup = action.chat_id ?? action.chatId ?? null
      const inputFingerprint = stableId('phone-provision-intent', { prompt, title: action.title ?? action.displayName ?? null, harness, model: action.model ?? caller?.platformModel ?? null, chat: requestedGroup, projectId: action.projectId ?? action.project_id ?? null, projectPath: action.projectPath ?? action.project_path ?? null, callerSession: caller?.sessionId ?? null, callerDevice: caller?.deviceId ?? null,...(intent ? {assistantWork:intent} : {}) })
      if (request?.inputFingerprint && request.inputFingerprint !== inputFingerprint) throw new Error('同一个创建请求不能更换任务、名字、群或模型；请开始一条新的创建请求')
      if (request?.result) return request.result
      if (!request) {
        let birthGroupChatId = null
        if (requestedGroup) {
          const query = cloud.chat.from('chats').select('id,kind,status')
          const { data, error } = /^\d+$/.test(requestedGroup) ? await query.eq('public_id', Number(requestedGroup)).single() : await query.eq('id', uuid(requestedGroup, 'birth group chat_id')).single()
          if (error) throw new Error(error.message)
          if (!data || data.kind !== 'group' || data.status === 'archived') throw new Error('新 Agent 只能申请加入主人所在的有效群聊')
          birthGroupChatId = data.id
        }
        const modelId = await models.resolve(action.model ?? caller?.platformModel)
        request = { kind: 'spawn',...(intent ? {assistantWork:intent} : {}), inputFingerprint, birthGroupChatId, operationId: randomUUID(), provisionId: randomUUID(), displayName: action.title?.trim() || action.displayName?.trim() || '手机任务 Agent', modelId, prompt, caller, ...(inputDataProof ? { inputDataProof: structuredClone(inputDataProof) } : {}), createdAt: new Date().toISOString() }
      }
    } catch (cause) {
      // Only validation before durable admission is safe to edit. A recorded intent, a failed
      // journal save, or any formal provisioning RPC must keep the same id on retry.
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (!store.state.requests[requestId]) error.code = 'phone_create_rejected'
      throw error
    }
    if (!store.state.requests[requestId]) {
      store.state.requests[requestId] = request
      await store.save()
    }
    const member = { provision_id: request.provisionId, member_key: 'single', display_name: request.displayName, agent_type: 'pi', inherit_memory: false, history_import_required: false }
    await cloud.rpc('identity', 'start_agent_provision_operation', { p_operation_id: request.operationId, p_device_id: deviceId, p_blueprint: { kind: 'single', concurrency_limit: 1, members: [member] }, p_memory_content: null, p_initial_message: null, p_model: `platform:${request.modelId}`, p_effort: null, p_permission_mode: null })
    const readProvision = async () => {
      const { data, error } = await cloud.identity.from('agent_provisions').select('*').eq('id', request.provisionId).single()
      if (error) throw new Error(error.message)
      if (!data) throw new Error('正式 Agent 创建的持久记录不存在，未申请创建名额')
      return data
    }
    let row = await readProvision()
    if (row.provisioned_agent_user_id && !row.agent_user_id) throw new Error('这次创建绑定的 Agent 已被移除，不能通过重试重新创建身份')
    if (row.phase === 'queued' || row.phase === 'failed') {
      // The DB grants retries only for an explicitly selected, truly failed member. Reuse
      // its operation, provision and immutable Agent/DM binding, as the desktop saga does.
      const retry = row.phase === 'failed'
      const claimed = await cloud.rpc('identity', 'claim_provision_slots', { p_operation_id: request.operationId, p_limit: 1, p_retry_provision_ids: retry ? [request.provisionId] : null })
      row = (Array.isArray(claimed) ? claimed.find((item) => item.id === request.provisionId) : null) ?? await readProvision()
      if (row.phase !== 'preparing') throw new Error('正式 Agent 创建尚未获得运行名额，请继续同一次创建')
    }
    if (row.phase === 'preparing') row = first(await cloud.rpc('identity', 'prepare_agent_provision', { p_provision_id: row.id, p_operation_id: row.operation_id, p_member_key: row.member_key, p_device_id: row.device_id, p_display_name: row.display_name, p_agent_type: row.agent_type, p_project_path: row.project_path, p_avatar: row.avatar, p_special_focus: row.special_focus, p_initial_message_id: row.initial_message_id ?? null, p_initial_message_text: row.initial_message_text ?? null }))
    if (!row?.agent_user_id || !row.create_command_id) throw new Error('正式 Agent 创建没有返回身份或设备命令')
    await tick()
    const { data: command, error: commandError } = await cloud.identity.from('gugu_device_commands').select('status,error').eq('id', row.create_command_id).single()
    if (commandError) throw new Error(commandError.message)
    if (command.status !== 'done' && command.status !== 'error') throw new Error('手机 Agent 创建尚未完成，请先检查 session_children 再重试')
    row = first(await cloud.rpc('identity', 'settle_agent_provision_terminal', { p_provision_id: row.id }))
    if (row.phase === 'failed') throw new Error(row.error || '手机 Agent 创建失败')
    await cloud.rpc('identity', 'complete_agent_provision', { p_provision_id: row.id })
    const agent = store.state.agents[row.agent_user_id]
    if (!agent) throw new Error('Agent 创建命令已完成，但手机会话不存在')
    if(request.assistantWork && agent.sessionId!==request.assistantWork.child_session_id) {
      if(Object.values(store.state.jobs).some(job=>job.agentUserId===agent.agentUserId)
        || Object.values(store.state.agents).some(other=>other!==agent && other.sessionId===request.assistantWork.child_session_id)) throw new Error('Assistant work seat ID belongs to an existing phone conversation')
      agent.sessionId=request.assistantWork.child_session_id
    }
    if(request.assistantWork) agent.assistantWork=request.assistantWork
    if (caller) {
      agent.caller = caller
      agent.knownSessions ??= {}; agent.knownSessions[caller.sessionId] = caller.deviceId
    }
    if (request.birthGroupChatId && !agent.birthGroup) {
      try {
        // The UI acts as the owner; an Agent caller must retain its own group authority.
        const joined = await cloud.rpc('chat', 'add_group_agent', { p_chat_id: request.birthGroupChatId, p_agent_user_id: agent.agentUserId, p_message: null, p_as_user_id: caller?.agentUserId ?? ownerId, p_as_task: true })
        if (!joined || !['joined', 'pending_approval'].includes(joined.status)) throw new Error('群聊没有确认 Agent 加入或待审批的状态')
        agent.birthGroup = { chatId: request.birthGroupChatId, status: joined.status }
      } catch (error) { agent.birthGroup = { chatId: request.birthGroupChatId, status: 'failed', error: error.message } }
    }
    await store.save()
    if(request.assistantWork) {
      request.result={...snapshot(agent),assistant_work_target:{session_id:agent.sessionId,device_id:deviceId}}
      await store.save();publish()
      return request.result
    }
    const id = stableId(request.operationId, 'initial-task')
    const source = caller ?? { sessionId: agent.sessionId, name: '主人', deviceId, agentUserId: ownerId }
    if (caller) await admit({ id, agentUserId: agent.agentUserId, prompt: buildSessionDirectEnvelope({ senderSessionId: source.sessionId, senderTitle: source.name, messageId: id, content: request.prompt, at: formatDeliveryTimestamp(new Date().toISOString()) }), ...(request.inputDataProof ? { inputDataProof: request.inputDataProof } : {}), route: { kind: 'session-direct', caller, sourceMessageId: id } })
    else await admit({ id, agentUserId: agent.agentUserId, prompt: request.prompt, route: { kind: 'task', senderUserId: ownerId } })
    request.result = snapshot(agent)
    await store.save(); publish()
    return request.result
  }
  const provision = async (requestId, action, caller = null, inputDataProof = null) => {
    const key = action.assistant_work ? `assistant-work:${assistantWorkIntentSchema.parse(action.assistant_work).operation_id}` : action.clientRequestId ? `client:${uuid(action.clientRequestId, 'clientRequestId')}` : required(requestId, 'request id')
    const active = provisioning.get(key)
    if (active) {
      // Even concurrent retries must pass the durable intent check before reusing the answer.
      await active
      return provisionOnce(key, action, caller, inputDataProof)
    }
    const operation = provisionOnce(key, action, caller, inputDataProof).finally(() => { provisioning.delete(key) })
    provisioning.set(key, operation)
    return operation
  }

  return provision
}
