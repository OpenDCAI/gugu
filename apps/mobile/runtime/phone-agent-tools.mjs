import { effectiveGroupRules, groupRulesVersion, groupRulesLedgerFor } from '../../../packages/core/src/local/agent/groupRulesDelivery.ts'
import { stableId, uuid } from './phone-agent-store.mjs'
import { createPhoneChatAccess } from './phone-agent-chat.mjs'

const toolResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data })
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
const bare = (value, prefix) => value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : value
const rowOf = (data) => Array.isArray(data) ? data[0] : data

/** The Pi tools are real Gugu writes with the agent's own sender identity. */
export function phoneCommunicationTools({ agent, job, cloud, store, env, sendSession, emit, authorize }) {
  const chatAccess = createPhoneChatAccess({ agent, cloud, store, env })
  const chatId = async (value) => {
    const target = text(value, 'chat_id')
    if (/^\d+$/.test(target)) {
      const { data, error } = await cloud.chat.from('chats').select('id').eq('public_id', Number(target)).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'chat_id')
    }
    return uuid(target, 'chat_id')
  }
  const userId = async (value) => {
    if (value.startsWith('user:')) return uuid(bare(value, 'user'), 'recipient')
    if (value.startsWith('session:')) {
      const target = Object.values(store.state.agents).find((item) => item.sessionId === bare(value, 'session'))
      if (!target) throw new Error('该会话不在这台手机上，请用 session_message 联系它')
      return target.agentUserId
    }
    if (/^gugu:\d+$/.test(value)) {
      const { data, error } = await cloud.identity.from('users').select('id').eq('gugu_number', Number(bare(value, 'gugu'))).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'recipient')
    }
    throw new Error('收件人必须使用 user:、gugu: 或 session: 地址')
  }
  const facts = async (id) => rowOf(await cloud.rpc('chat', 'chat_facts', { p_chat_id: id, p_as_user_id: agent.agentUserId }))
  const ledger = groupRulesLedgerFor(env)
  const rules = async (id) => effectiveGroupRules(id, facts)
  const messageSend = async (callId, args) => {
    await authorize(job.usedGroups ?? [])
    const id = await chatId(args.chat_id)
    const body = text(args.text, 'text')
    const currentRules = await rules(id)
    if (currentRules.trim()) {
      const seen = await ledger.read(agent.agentUserId, id)
      if (seen?.version !== groupRulesVersion(currentRules)) throw new Error('发送前必须先调用 message_rules 阅读这条聊天的当前群规')
    }
    const recipients = Array.isArray(args.to_user_ids) ? await Promise.all(args.to_user_ids.map(userId)) : null
    await chatAccess.beforeWrite(id, recipients)
    if (args.whisper && recipients?.length !== 1) throw new Error('悄悄话必须恰好指定一个收件人')
    const messageId = stableId('phone-message', agent.agentUserId, job.id, id, body, recipients, args.reply_to_message_id ?? null, args.whisper === true)
    const message = { id: messageId, chatId: id, agentUserId: agent.agentUserId, sessionId: agent.sessionId, usedGroups: [...(job.usedGroups ?? [])], permissionRequirements: structuredClone(job.permissionRequirements ?? []), toUserIds: recipients, content: body, replyToMessageId: args.reply_to_message_id ? uuid(bare(args.reply_to_message_id, 'msg'), 'reply source') : null, threadRootId: job.route?.chatId === id ? job.route.threadRootId ?? null : null, isWhisper: args.whisper === true }
    store.state.outbox[messageId] ??= { ...message, status: 'pending', createdAt: new Date().toISOString() }
    await store.save()
    const data = await deliverPhoneOutbox(cloud, store, messageId, authorize)
    job.sent = [...new Set([...(job.sent ?? []), messageId])]
    await store.save()
    emit({ type: 'message_sent', sessionId: agent.sessionId, agentUserId: agent.agentUserId, chatId: id, messageId })
    return toolResult({ ok: true, message_id: `msg:${messageId}`, chat_id: id, message: data })
  }
  return [
    {
      name: 'message_send', label: '发送咕咕消息', description: '以你自己的咕咕 Agent 身份发消息。chat_id 取自本轮投递或 message_conversations，收件人地址取自 message_members。回复聊天投递必须调用本工具；打印最终回答不会发送。群聊请明确指定收件人的 typed 地址；回复请带 reply_to_message_id。',
      parameters: { type: 'object', required: ['chat_id', 'text'], properties: { chat_id: { type: 'string' }, text: { type: 'string' }, to_user_ids: { type: 'array', items: { type: 'string' } }, reply_to_message_id: { type: 'string' }, whisper: { type: 'boolean' } } },
      execute: messageSend,
    },
    {
      name: 'message_rules', label: '读取当前群规', description: '按你的 Agent 身份读取这条聊天及来源群的当前群规；在发送前执行群规检查。',
      parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' } } },
      execute: async (_callId, args) => {
        const id = await chatId(args.chat_id)
        const current = await rules(id)
        await ledger.write(agent.agentUserId, id, { version: groupRulesVersion(current), contextKey: agent.sessionId })
        return toolResult({ chat_id: id, rules: current })
      },
    },
    {
      name: 'session_message', label: '联系其他任务 Agent', description: '向任务会话发消息。收件人用 session:<id> 地址。本轮来自 session-direct 时，必须用本工具回复来源会话。消息实际经咕咕设备 RPC 到收件人宿主。',
      parameters: { type: 'object', required: ['to', 'text'], properties: { to: { type: 'array', minItems: 1, items: { type: 'string' } }, text: { type: 'string' }, reply_to_message_id: { type: 'string' }, then: { type: 'string', enum: ['continue', 'wait', 'stop'] } } },
      execute: async (callId, args) => {
        await authorize(job.usedGroups ?? [])
        if (!Array.isArray(args.to) || !args.to.length) throw new Error('to is required')
        const ids = [...new Set(args.to.map((id) => uuid(bare(id, 'session'), 'session recipient')))]
        const result = await sendSession(agent, ids, text(args.text, 'text'), { reply_to_message_id: args.reply_to_message_id, then: args.then }, stableId(job.id, callId))
        job.sent = [...new Set([...(job.sent ?? []), callId])]
        await store.save()
        return toolResult(result)
      },
    },
    {
      name: 'profile_whoami', label: '查看自己的身份', description: '返回你自己的真实咕咕 Agent 身份和手机运行位置。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const { data, error } = await cloud.identity.from('users').select('id,display_name,gugu_number,owner_user_id,device_id').eq('id', agent.agentUserId).single()
        if (error) throw new Error(error.message)
        return toolResult({ user_id: `user:${agent.agentUserId}`, session_id: `session:${agent.sessionId}`, display_name: data.display_name, gugu_number: data.gugu_number, device_id: `device:${agent.deviceId}`, owner_user_id: `user:${store.state.ownerId}` })
      },
    },
  ]
}

export async function deliverPhoneOutbox(cloud, store, id, authorize = async () => undefined) {
  const message = store.state.outbox[id]
  if (!message) throw new Error('phone reply journal entry is missing')
  if (message.status === 'sent') return message.receipt
  if (message.status === 'revoked') throw new Error('这条手机结果的授权已撤销，不能重新交付')
  try { await authorize(message.usedGroups ?? [], message) } catch (error) {
    if (['revoked', 'not_granted', 'os_permission'].includes(error.code)) {
      message.status = 'revoked'; message.error = error.message
      await store.save()
    }
    throw error
  }
  const data = await cloud.rpc('chat', 'send_message_idempotent', {
    p_message_id: message.id, p_chat_id: message.chatId, p_sender_user_id: message.agentUserId,
    p_to_user_ids: message.toUserIds, p_content: message.content, p_content_type: 'text',
    p_reply_to_message_id: message.replyToMessageId, p_thread_root_id: message.threadRootId,
    p_is_thread_root: false, p_is_whisper: message.isWhisper,
  })
  const row = rowOf(data)
  if (!row || typeof row.id !== 'string') throw new Error('send_message_idempotent returned no message receipt')
  message.status = 'sent'; message.receipt = { id: row.id }; message.sentAt = new Date().toISOString()
  await store.save()
  return message.receipt
}
