import { randomUUID } from 'node:crypto'
import { PHONE_ACTIONS, phoneActionByName } from '../../desktop/src/mobile/phone-device/phoneActionCatalog.ts'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { withPhoneNativeContext } from './phone-capacitor.mjs'
import { stableId } from './phone-agent-store.mjs'
import { receivePhoneArtifact } from './phone-agent-files.mjs'
import { utcOffsetOf } from '../../desktop/src/mobile/phone-device/phoneTime.ts'

const result = (data, content) => ({ content: content ?? [{ type: 'text', text: JSON.stringify(data) }], details: data })
const failure = (code, message) => Object.assign(new Error(message), { code })
const isFile = (name) => name === 'photos.read' || name === 'recordings.read'
const phoneFileDescriptions = {
  'recordings.read': '读取 recordings.list 返回的原始音频，分块保存到当前手机任务的 App 私有目录；返回可供 message_send_file 发送的完整 file_path、mime_type、size、sha256。建议传列表的 version。不会开启麦克风，也不提供音频转写或理解；撤权、断开或文件变化时不返回残缺文件。',
  'photos.read': '读取 photos.list 返回的原始照片或视频，分块保存到当前手机任务的 App 私有目录；kind 与列表一致，建议传 version。返回可供 message_send_file 发送的完整文件路径及元数据，不表示本模型已理解图片或视频内容；系统授权范围外的文件不能读取。',
}
const confirmationOptions = [{ optionId: 'approve', name: '允许这一次', kind: 'allow_once' }, { optionId: 'cancel', name: '取消', kind: 'reject_once' }]

export function phoneConfirmationSettlement(pending) {
  const answered = Boolean(pending.respondedAt ?? pending.approvedByMessageId)
  return { itemId: pending.id, kind: 'permission', title: pending.question,
    detail: `${pending.actionName}\n${JSON.stringify(pending.args)}\n确认有效期至 ${pending.expiresAt}`,
    options: confirmationOptions,
    state: answered ? 'resolved' : pending.status === 'pending' ? 'pending' : 'cancelled',
    optionId: answered ? pending.responseOption ?? 'approve' : null,
    resolvedBy: answered ? pending.respondedBy ?? pending.ownerId : null,
    resolvedAt: answered ? Date.parse(pending.respondedAt ?? pending.finishedAt ?? pending.createdAt) : null }
}

export async function createPhoneActionRuntime({ ownerId, store, nativeCall, sendSession, emit, getManifest }) {
  store.state.confirmations ??= {}
  for (const pending of Object.values(store.state.confirmations)) {
    if (!Object.hasOwn(pending, 'contextEpoch')) {
      pending.contextEpoch = 'legacy-unscoped'
      if (['pending', 'approved'].includes(pending.status)) { pending.status = 'cancelled'; pending.error = '旧版手机确认缺少任务上下文，已失效，请在任务页重新发起操作' }
    }
    // Old DM prompts are historical messages, never an approval transport after upgrade.
    const question = store.state.outbox[pending.messageId]
    if (question?.status === 'pending') question.status = 'superseded'
    if (pending.status === 'executing') { pending.status = 'interrupted'; pending.error = '手机在执行中停止，结果尚未确认，不能自动重复执行。' }
  }
  await store.save()
  const reconcile = async () => {
    let changed = false
    for (const pending of Object.values(store.state.confirmations)) if (pending.status === 'pending' && Date.parse(pending.expiresAt) <= Date.now()) {
      pending.status = 'expired'; changed = true
      const question = store.state.outbox[pending.messageId]
      if (question?.status === 'pending') question.status = 'expired'
    }
    for (const agent of Object.values(store.state.agents)) if (agent.status === 'needs_user' && !Object.values(store.state.confirmations).some((pending) => pending.agentUserId === agent.agentUserId && pending.status === 'pending')) { agent.status = 'idle'; changed = true }
    if (changed) await store.save()
    return changed
  }
  await reconcile()

  const check = async (agent, groups, signal, requirements = []) => {
    if (!groups.length && !requirements.length) return
    const permit = await nativeCall('permissions.check', { groups: [...new Set(groups)], requirements }, signal, { ownerId, sessionId: agent.sessionId })
    if (!permit?.ok) throw failure(permit?.code ?? 'not_granted', permit?.message ?? '手机能力授权已改变')
  }
  const preflight = async (agent, groups, signal) => {
    const permit = await nativeCall('permissions.preflight', { groups: [...new Set(groups)] }, signal, { ownerId, sessionId: agent.sessionId })
    if (!permit?.ok) throw failure(permit?.code ?? 'not_granted', permit?.message ?? '手机能力授权已改变')
  }
  const input = (name, raw) => {
    const action = phoneActionByName(name)
    if (!action) throw failure('unknown_action', `这台手机没有 ${name} 动作`)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('invalid_args', 'args 必须是参数对象')
    if (['confirmed', 'approval', 'internalApproval', '_phone_file_transport', 'offset'].some((field) => field in raw)) throw failure('invalid_args', '确认和文件传输由宿主处理，不能由模型填写')
    let args
    try { args = validateToolArguments({ name, parameters: action.input_schema }, { name, arguments: raw }) }
    catch (error) { throw failure('invalid_args', error.message) }
    return { action, args }
  }

  const execute = async ({ agent, job, action, args, signal, origin = 'phone-agent', approval, callId }) => {
    await preflight(agent, [action.group], signal)
    const requirements = []
    let nativeUnconfirmed = false
    const context = { nativeCall, signal, ownerId, sessionId: agent.sessionId, actionName: action.name, origin, ...(approval ? { approval } : {}),
      // The shared catalog normalizes native errors for the device-action contract. Keep
      // lost-result provenance locally before that mapping erases timeout/disconnect codes.
      recordNativeFailure: (error) => { if (['execution_unknown', 'timeout'].includes(error.code)) nativeUnconfirmed = true },
      recordPermissionRequirements: async (proof) => {
        requirements.push(proof)
        if (job) { job.permissionRequirements ??= []; if (!job.permissionRequirements.some((saved) => JSON.stringify(saved) === JSON.stringify(proof))) job.permissionRequirements.push(proof); await store.save() }
      } }
    const invoke = (next) => withPhoneNativeContext(context, () => action.run(next))
    const prepared = isFile(action.name) ? { ...args, _phone_file_transport: 1 } : args
    let data
    try { data = await invoke(prepared) }
    catch (error) { if (nativeUnconfirmed) throw failure('execution_unknown', '手机原生调用结果尚未确认'); throw error }
    let content
    if (isFile(action.name) && origin === 'phone-agent') {
      const file = await receivePhoneArtifact({ first: data, args: prepared, read: invoke, agent, job, signal, store, root: process.env.GUGU_AGENT_HOME, group: action.group })
      data = file.data; content = file.content
    }
    await check(agent, [action.group], signal, requirements)
    if (job) { job.usedGroups = [...new Set([...(job.usedGroups ?? []), action.group])]; await store.save() }
    emit({ type: 'phone_action', ownerId, sessionId: agent.sessionId, action: action.name, callId, ok: true })
    return { data, content }
  }

  const askOwner = async (agent, job, action, args, callId, signal) => {
    await preflight(agent, [action.group], signal)
    await check(agent, job.usedGroups ?? [], signal, job.permissionRequirements ?? [])
    const described = action.confirmQuestion ? action.confirmQuestion(args) : { question: `要让手机「${action.title}」吗？` }
    // Run the shared normalization/validation with a transport that cannot touch Android.
    // Confirmation is offered only after all parameters are valid.
    await withPhoneNativeContext({ nativeCall: async () => ({ ok: true, data: {} }), ownerId, sessionId: agent.sessionId }, () => action.run(args))
    const id = stableId('phone-confirmation', agent.agentUserId, job.id, callId)
    let pending = store.state.confirmations[id]
    if (!pending) {
      const code = randomUUID().slice(0, 8)
      const messageId = stableId(id, 'owner-question')
      pending = { id, code, ownerId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, jobId: job.id, contextEpoch: agent.contextEpoch ?? null, actionName: action.name, args: structuredClone(args), usedGroups: structuredClone(job.usedGroups ?? []), permissionRequirements: structuredClone(job.permissionRequirements ?? []), originRoute: job.route, question: described.question, messageId, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
      store.state.confirmations[id] = pending
      await store.save()
    }
    if (pending.status !== 'pending') return result({ ok: false, code: pending.status, message: '这次确认已结束，请检查实际结果后重新发起。' })
    await preflight(agent, [action.group], signal)
    await check(agent, job.usedGroups ?? [], signal, job.permissionRequirements ?? [])
    job.waitingConfirmation = pending.id
    await store.save()
    emit({ type: 'confirmation_pending', ownerId, sessionId: agent.sessionId, confirmationId: pending.id })
    return result({ ok: false, code: 'needs_confirmation', confirmation_id: pending.id, message: '已在这条任务的时间线中请求主人确认。主人在手机任务页明确批准后才会执行；不能自行确认。', question: pending.question })
  }

  return {
    reconcile,
    tools({ agent, job }) { return [
      { name: 'phone_actions', label: '查看手机能力', description: '列出这台手机已有的受控动作、参数和当前授权状态。手机权限与系统权限均由本机执行时检查。', parameters: { type: 'object', properties: { group: { type: 'string' } } },
        execute: async (_callId, args) => result({ actions: PHONE_ACTIONS.filter((action) => !args.group || action.group === args.group).map((action) => {
          const registered = getManifest().find((entry) => entry.name === action.name)
          const inputSchema = { ...action.input_schema, properties: Object.fromEntries(Object.entries(action.input_schema.properties ?? {}).filter(([name]) => name !== 'confirmed')) }
          return { name: action.name, group: action.group, title: action.title, description: phoneFileDescriptions[action.name] ?? action.description({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffset: utcOffsetOf(new Date()) }), input_schema: inputSchema, confirm: action.confirm, available: registered?.available ?? false, unavailable_detail: registered?.unavailable_detail ?? null }
        }) }) },
      { name: 'phone_call', label: '使用手机能力', description: '执行 phone_actions 列出的受控手机动作。name 为动作名，args 按该动作参数填写。需要确认的动作会由宿主在任务时间线中请求真人主人批准；你不能自行确认或填写 confirmed/approval。媒体文件会保存在本会话的私有目录，可通过 message_send_file 发送。', parameters: { type: 'object', required: ['name', 'args'], properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: true } } },
        execute: async (callId, raw, signal) => {
          try {
            const { action, args } = input(raw.name, raw.args)
            if (action.confirm === 'always') return await askOwner(agent, job, action, args, callId, signal)
            const completed = await execute({ agent, job, action, args, signal, callId })
            return result({ ok: true, data: completed.data }, completed.content)
          } catch (error) { return result({ ok: false, code: error.code ?? 'execution_failed', message: error.message }) }
        } },
    ] },

    confirmationForMessage() { return null },

    settlements(agent) { return Object.values(store.state.confirmations).filter((pending) => pending.agentUserId === agent.agentUserId && pending.contextEpoch === (agent.contextEpoch ?? null)).map(phoneConfirmationSettlement) },

    async resetContext(agent) {
      for (const pending of Object.values(store.state.confirmations)) if (pending.agentUserId === agent.agentUserId && ['pending', 'approved'].includes(pending.status)) {
        pending.status = 'cancelled'; pending.finishedAt = new Date().toISOString(); pending.error = '手机数据授权已改变，原确认已失效，请重新发起操作'
      }
      await store.save()
    },

    async respond(agent, input, source, admit) {
      if (source?.kind !== 'native-ui' || source.ownerId !== ownerId) throw failure('not_granted', '手机操作需要主人在这台手机的任务页确认，其他 Agent 不能代替主人批准')
      if (input.kind !== 'permission' || !confirmationOptions.some((option) => option.optionId === input.optionId)) throw failure('invalid_args', '这条手机操作的确认选项无效')
      const pending = store.state.confirmations[input.itemId]
      if (!pending || pending.ownerId !== ownerId || pending.agentUserId !== agent.agentUserId || pending.sessionId !== agent.sessionId || pending.contextEpoch !== (agent.contextEpoch ?? null)) throw failure('not_granted', '这条手机操作不属于当前主人和任务上下文')
      await check(agent, [], undefined)
      if (pending.status !== 'pending') return { accepted: false, settlement: phoneConfirmationSettlement(pending) }
      if (Date.parse(pending.expiresAt) <= Date.now()) { pending.status = 'expired'; pending.finishedAt = new Date().toISOString(); await store.save(); return { accepted: false, settlement: phoneConfirmationSettlement(pending) } }
      // Claim before the first asynchronous admission. Pending and its response job are saved
      // together by admit, so a second click cannot enqueue another native operation.
      const responseId = stableId(pending.id, 'task-response')
      pending.status = 'approved'; pending.responseOption = input.optionId; pending.respondedBy = source.ownerId; pending.respondedAt = new Date().toISOString()
      await admit({ id: responseId, agentUserId: agent.agentUserId, kind: 'confirmation', confirmationId: pending.id,
        confirmationDecision: input.optionId === 'approve' ? 'approve' : 'cancel',
        confirmationSource: { kind: 'task', messageId: responseId, senderUserId: ownerId, sessionId: agent.sessionId },
        prompt: input.optionId === 'approve' ? `主人已在任务页允许这次手机操作：${pending.question}` : `主人已在任务页取消这次手机操作：${pending.question}`,
        route: { kind: 'task', senderUserId: ownerId } })
      return { accepted: true, settlement: phoneConfirmationSettlement(pending) }
    },

    async cancel(agent, options = {}) {
      for (const pending of Object.values(store.state.confirmations)) if (pending.agentUserId === agent.agentUserId && (!options.jobId || pending.jobId === options.jobId) && ['pending', 'approved'].includes(pending.status)) { pending.status = 'cancelled'; pending.finishedAt = new Date().toISOString() }
      await store.save()
    },

    async runConfirmation(agent, job, signal) {
      const pending = store.state.confirmations[job.confirmationId]
      const source = job.confirmationSource
      const taskSource = source?.kind === 'task' && source.sessionId === agent.sessionId && pending?.respondedBy === ownerId && source.messageId === stableId(pending?.id, 'task-response')
      if (!pending || pending.agentUserId !== agent.agentUserId || pending.ownerId !== ownerId || source?.senderUserId !== ownerId || !taskSource || source?.messageId !== job.id || pending.contextEpoch !== (agent.contextEpoch ?? null)) throw failure('not_granted', '确认来源与当前主人、操作或任务上下文不匹配')
      if (pending.status !== 'approved') return { ok: false, code: pending.status, message: pending.error ?? '这次操作已经处理，不能重复执行。' }
      if (Date.parse(pending.expiresAt) <= Date.now()) { pending.status = 'expired'; await store.save(); return { ok: false, code: 'expired', message: '确认已过期，请重新发起操作。' } }
      if (job.confirmationDecision === 'cancel') { pending.status = 'cancelled'; await store.save(); return { ok: false, code: 'cancelled', message: '主人已取消本次操作。' } }
      const action = phoneActionByName(pending.actionName)
      if (!action || action.confirm !== 'always') throw failure('invalid_args', '这次确认对应的手机动作已改变')
      await preflight(agent, [action.group], signal)
      await check(agent, pending.usedGroups ?? [], signal, pending.permissionRequirements ?? [])
      pending.status = 'executing'; pending.approvedByMessageId = source.messageId
      await store.save()
      let outcome
      try {
        signal?.throwIfAborted()
        const completed = await execute({ agent, job, action, args: pending.args, signal, approval: { ownerId, actionName: action.name, requestId: pending.id, sourceMessageId: source.messageId, approved: true }, callId: pending.id })
        outcome = { ok: true, action: action.name, data: completed.data }
        pending.status = 'done'; pending.outcome = outcome
      } catch (error) {
        const unconfirmed = signal?.aborted || ['execution_unknown', 'timeout'].includes(error.code)
        outcome = unconfirmed ? { ok: false, action: action.name, code: 'execution_unknown', message: `${signal?.aborted ? '任务在执行过程中取消' : '手机原生调用未能确认完成'}，操作结果尚未确认，请检查手机；不能自动重复执行。` }
          : { ok: false, action: action.name, code: error.code ?? 'execution_failed', message: error.message }
        pending.status = unconfirmed ? 'interrupted' : 'failed'; pending.error = outcome.message
      }
      pending.finishedAt = new Date().toISOString(); await store.save()
      if (pending.originRoute?.kind === 'session-direct' && pending.originRoute.caller?.sessionId) {
        await check(agent, job.usedGroups ?? [], undefined, job.permissionRequirements ?? [])
        await sendSession(agent, [pending.originRoute.caller.sessionId], `手机操作确认已处理：${JSON.stringify(outcome)}`, { reply_to_message_id: pending.originRoute.sourceMessageId }, stableId(pending.id, 'confirmed-result'))
      }
      return outcome
    },

    async runDeviceAction(name, args, context) {
      const action = phoneActionByName(name)
      if (!action) return { ok: false, code: 'unknown_action', message: `这台手机没有 ${name} 动作` }
      if (action.confirm === 'always' && args.confirmed !== true) return { ok: false, code: 'needs_confirmation', message: action.confirmQuestion?.(args)?.question ?? `要让手机「${action.title}」吗？` }
      const agent = { sessionId: stableId('device-action', context.callId) }
      try {
        const completed = await execute({ agent, action, args, signal: context.signal, origin: 'device-rpc', callId: context.callId, approval: action.confirm === 'always' ? { confirmed: true, callId: context.callId } : undefined })
        return { ok: true, data: completed.data }
      } catch (error) { return { ok: false, code: error.code === 'execution_unknown' ? 'execution_failed' : error.code ?? 'execution_failed', message: error.message } }
    },
  }
}
