import { uploadSessionFile } from '../../../packages/core/src/local/agent/sessionFileHandoff.ts'
import { revokeSessionAttachment } from '../../../packages/core/src/cloud/sessionAttachments.ts'
import { authorizedPhoneArtifact } from './phone-agent-files.mjs'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { SESSION_TOOL_DEFS } from '../../desktop/electron/mcp/gugu-session-tool.ts'
import { registerSessionpageTools } from '../../desktop/electron/mcp/sessionpage-tool-registrar.ts'
import { windowResult, matchesAgentStatus } from '../../desktop/electron/mcp/list-window.mjs'
import { createCrossMachineSessions } from '../../desktop/electron/cross-machine-sessions.ts'
import { handleUnifiedSessionMessage } from '../../desktop/electron/unified-session-message.ts'
import { listDevices } from '../../../packages/core/src/cloud/devices.ts'
import { stableId } from './phone-agent-store.mjs'
import { withAssistantWorkReply } from '../../../packages/core/src/shared/assistantWorkReply.ts'

const permitted = new Set(['session_devices', 'session_list_harnesses', 'session_list_models', 'session_spawn', 'session_children', 'session_message', 'session_get', 'session_stop'])
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value })

/** The phone uses the same owner-device routing, identity aliases and typed tool boundary as desktop. */
export function createPhoneSessionTools({ agent, job, cloud, store, deviceId, work, requester, invoke, authorize, emit }) {
  const local = () => Object.values(store.state.agents)
  const caller = () => ({ deviceId, deviceLabel: 'Android', sessionId: agent.sessionId, agentUserId: agent.agentUserId, name: agent.displayName, harness: 'pi', transport: 'acp', model: null, platformModel: `platform:${agent.modelId}` })
  const lookupAgents = async ({ userIds, numbers }) => {
    const found = new Map()
    for (const [field, values] of [['id', userIds], ['gugu_number', numbers]]) {
      for (let offset = 0; offset < values.length; offset += 50) {
        const { data, error } = await cloud.identity.from('users').select('id,gugu_number,device_id').eq('owner_user_id', store.state.ownerId).eq('type', 'agent').in(field, values.slice(offset, offset + 50))
        if (error) throw new Error(error.message)
        for (const row of data ?? []) found.set(row.id, { userId: row.id, guguNumber: row.gugu_number, deviceId: row.device_id })
      }
    }
    return [...found.values()]
  }
  const cross = createCrossMachineSessions({ thisDeviceId: async () => deviceId, listDevices: () => listDevices(cloud.identity, store.state.ownerId), lookupAgents, requester })
  // This source is supplied by the host-owned tool closure, never by model arguments or RPC.
  const here = (action, callId) => invoke(`agentSession.${action.action}`, [caller(), action], stableId('phone-session-tool', job.id, callId, action), { kind: 'phone-agent', agentUserId: agent.agentUserId, jobId: job.id })
  const prepareFiles = async (files, targets, callId, signal) => {
        await cross.assertFileHandoffSupported(targets.flatMap(target => target.deviceId && !target.agentId ? [target.deviceId] : []))
        const recipientIds = []
        const peers = new Map()
        for (const target of targets) {
          let recipient = target.agentId ?? local().find(row => row.sessionId === target.sessionId)?.agentUserId
          if (target.deviceId && !target.agentId) {
            if (!peers.has(target.deviceId)) peers.set(target.deviceId, await cross.runOnDevice(target.deviceId, caller(), { action: 'peers' }, signal))
            const row = peers.get(target.deviceId).find(row => row.sessionId === target.sessionId || row.session_id === target.sessionId)
            recipient = row?.agentUserId ?? row?.agent_user_id?.replace(/^user:/, '') ?? row?.identity?.users?.id
          }
          if (!recipient) throw new Error('附件收件会话没有 Agent 身份')
          recipientIds.push(recipient)
        }
        const artifacts = await Promise.all(files.map(descriptor => authorizedPhoneArtifact({ agent, job, store, authorize }, descriptor.file_path)))
        const refs = []; const created = []
        try {
        for (const [index, descriptor] of files.entries()) {
          const { file } = artifacts[index]
          const id = stableId('session-file', job.id, callId, index)
          store.state.sessionFileOutbox ??= {}
          const fingerprint = JSON.stringify({ file: descriptor, recipients: recipientIds, sha256: file.sha256 })
          const entry = store.state.sessionFileOutbox[id] ??= { fingerprint }
          if (entry.fingerprint !== fingerprint) throw new Error('附件请求号已绑定另一份文件或收件人')
          if (entry.reference) { refs.push(entry.reference); continue }
          const reference = await uploadSessionFile(await cloud.attachmentEndpoint(), descriptor, {
            agentId: agent.agentUserId, sessionId: agent.sessionId, recipients: recipientIds, expectedSha256: file.sha256,
            attachmentId: id, stagingKey: entry.stagingKey,
            onStaged: async key => { entry.stagingKey = key; await store.save() },
            beforeCommit: async () => { await authorizedPhoneArtifact({ agent, job, store, authorize }, descriptor.file_path) },
          })
          entry.reference = reference; created.push({ id, reference }); await store.save(); refs.push(reference)
        }
        return refs
        } catch (error) {
          // Preparation has not delivered anything. Never revoke cached references from an earlier delivery attempt.
          const endpoint = await cloud.attachmentEndpoint()
          const failures = []
          for (const { id, reference } of created) {
            try { await revokeSessionAttachment(endpoint, reference.attachment_id, agent.agentUserId); delete store.state.sessionFileOutbox[id] } catch (failure) { failures.push(failure) }
          }
          await store.save()
          if (failures.length) throw new AggregateError([error, ...failures], 'File preparation failed and revocation could not be confirmed')
          throw error
        }
      }
  const send = async (action, callId, signal) => {
    await authorize(job.usedGroups ?? [])
    action=await withAssistantWorkReply(action,job.prompt,async (number)=>{
      const own=local().find((row)=>row.guguNumber===number)
      return own ? own.agentUserId : (await lookupAgents({userIds:[],numbers:[number]})).find((row)=>row.guguNumber===number)?.userId
    })
    const sent = action.work_result
      ? await work.enqueueReport({agent,job,callId,record:action,prepare:(files,target)=>prepareFiles(files,[target],callId,signal)})
      : await handleUnifiedSessionMessage(action, {
      caller: { sessionId: agent.sessionId, runtimeFork: false },
      prepareFiles: (files,targets) => prepareFiles(files,targets,callId,signal),
      graphMessage: (ids, text, said) => here({ action: 'message', session_ids: ids, text, ...said }, callId),
      localSessionsOfAgents: async (ids) => ({ sessions: new Map(local().filter((row) => ids.includes(row.agentUserId)).map((row) => [row.agentUserId, row.sessionId])), deletedRecipients: [] }),
      resolveLocalGuguNumbers: async (numbers) => new Map(local().filter((row) => numbers.includes(row.guguNumber)).map((row) => [row.guguNumber, row.agentUserId])),
      localSessionIds: async (ids) => ids.filter((id) => local().some((row) => row.sessionId === id)),
      remote: cross.messageDeps(async () => caller(), signal),
    })
    if (sent.recipients.some((recipient) => recipient.status === 'delivered' || recipient.status === 'accepted')) job.sent = [...new Set([...(job.sent ?? []), callId])]
    await store.save()
    emit({ type: 'session_message_sent', sessionId: agent.sessionId, agentUserId: agent.agentUserId, recipients: sent.recipients.map((row) => ({ to: row.to, status: row.status })) })
    return sent
  }
  const dispatch = async (action, callId, signal) => {
    if (action.action === 'devices') return cross.listDeviceRows()
    if (action.action === 'message') return send(action, callId, signal)
    if (action.action === 'spawn') await authorize(job.usedGroups ?? [])
    if (action.device && action.device !== deviceId) return cross.runOnDevice(action.device, caller(), action, signal)
    if (action.action === 'get' || action.action === 'stop') {
      const id = action.session_id ?? agent.sessionId
      if (!local().some((row) => row.sessionId === id)) return cross.runOnSession(id, caller(), { ...action, session_id: id }, signal)
      if (action.action === 'stop' && id === agent.sessionId) throw new Error('session_stop 停另一条会话；本轮结束请直接回复，不要停止自己')
      return here({ ...action, session_id: id }, callId)
    }
    if (action.action === 'children') {
      const id = action.session_id ?? agent.sessionId
      const own = await here({ ...action, session_id: id }, callId)
      return cross.withRemoteChildren(own, id, async () => caller(), signal)
    }
    return here(action, callId)
  }
  const defs = SESSION_TOOL_DEFS.filter((definition) => permitted.has(definition.name))
  const tools = defs.map((definition) => {
    const parameters = toJsonSchemaCompat(definition.schema, { strictUnions: true, pipeStrategy: 'input' })
    delete parameters.$schema
    return {
      name: definition.name, label: definition.name, description: definition.description, parameters,
      execute: async (callId, rawArgs, signal) => {
        const args = definition.schema.parse(rawArgs)
        let run
        // Reuse the real registrar's typed ID, list-window and per-item preview logic without an MCP transport.
        registerSessionpageTools({ registerTool: (_name, _options, handler) => { run = handler } }, [definition], (action, innerSignal) => dispatch(action, callId, innerSignal), () => '手机会话宿主尚未就绪', async (work) => work)
        const answer = await run(args, { signal })
        if (answer.isError) throw new Error(answer.content?.[0]?.text ?? '会话工具执行失败')
        return { ...answer, details: answer.content?.[0]?.text ? JSON.parse(answer.content[0].text) : null }
      },
    }
  })
  tools.push({
    name: 'session_peers', label: '查看任务 Agent', description: '这台手机或指定设备上的真实会话名录。收件人使用行中的 session:<id>、aid:<Agent ID> 或 gugu:<number>；不要猜名字或裸编号。',
    parameters: { type: 'object', properties: { device: { type: 'string' }, name: { type: 'string' }, rows: { type: 'string' }, status: { type: 'string' }, pinned: { type: 'boolean' } } },
    execute: async (callId, args, signal) => {
      const target = args.device ? String(args.device).replace(/^device:/, '') : deviceId
      if (args.device && !String(args.device).startsWith('device:')) throw new Error('device 必须使用 session_devices 返回的 device: 地址')
      const rows = await dispatch({ action: 'peers', device: target }, callId, signal)
      const shown = rows.map((row) => ({ ...row, session_id: row.sessionId ? `session:${row.sessionId}` : row.session_id, agent_user_id: row.agentUserId ? `user:${row.agentUserId}` : row.agent_user_id, is_self: row.agentUserId === agent.agentUserId }))
      return result(windowResult({ namesOf: (row) => [row.name, row.title, row.identity?.users?.display_name], statusFilter: true, keep: (row, filter) => matchesAgentStatus(row, filter.status) && (filter.pinned === undefined || row.pinned === filter.pinned) }, shown, args))
    },
  })
  return tools
}
