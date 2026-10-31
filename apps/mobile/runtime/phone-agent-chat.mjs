import { windowResult, matchesAgentStatus } from '../../desktop/electron/mcp/list-window.mjs'
import { effectiveGroupRules, groupRulesLedgerFor, groupRulesVersion } from '../../../packages/core/src/local/agent/groupRulesDelivery.ts'
import { uuid } from './phone-agent-store.mjs'

const row = (value) => Array.isArray(value) ? value[0] : value
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value })
const bare = (value, kind) => typeof value === 'string' ? value.replace(new RegExp(`^${kind}:`), '') : value
const limited = (value, fallback = 20) => { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('limit 必须在 1–100'); return value }
const listProperties = { name: { type: 'string' }, rows: { type: 'string' } }

export function encodePhoneChatRows(value, messageRows = false) {
  if (Array.isArray(value)) return value.map((item) => encodePhoneChatRows(item, messageRows))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && !entry.includes(':') && ['user_id', 'sender_user_id', 'owner_user_id', 'creator_user_id', 'agent_user_id', 'peer_user_id', 'reply_to_sender_user_id'].includes(key)) out[key] = `user:${entry}`
    else if (typeof entry === 'string' && !entry.includes(':') && (['message_id', 'reply_to_message_id', 'thread_root_id', 'source_message_id'].includes(key) || (messageRows && key === 'id'))) out[key] = `msg:${entry}`
    else if (key === 'to_user_ids' && Array.isArray(entry)) out[key] = entry.map((id) => id.includes(':') ? id : `user:${id}`)
    else out[key] = encodePhoneChatRows(entry, false)
  }
  return out
}

export function createPhoneChatAccess({ agent, cloud, store, env }) {
  const chats = async () => {
    const data = await cloud.rpc('chat', 'list_my_chats_as', { p_as_user_id: agent.agentUserId })
    if (!Array.isArray(data)) throw new Error('Agent 聊天列表未返回列表')
    return data
  }
  const chatId = async (address) => {
    if (typeof address !== 'string' || !address.trim()) throw new Error('chat_id 是必填的，请从 message_conversations 或本轮信封获取')
    if (/^\d+$/.test(address)) {
      const { data, error } = await cloud.chat.from('chats').select('id').eq('public_id', Number(address)).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'chat_id')
    }
    return uuid(address, 'chat_id')
  }
  const userId = async (address) => {
    if (typeof address !== 'string') throw new Error('收件人必须使用 typed 地址')
    if (address.startsWith('user:') || address.startsWith('aid:')) return uuid(address.slice(address.indexOf(':') + 1), 'recipient')
    if (address.startsWith('session:')) {
      const target = Object.values(store.state.agents).find((item) => item.sessionId === bare(address, 'session'))
      if (!target) throw new Error('该会话不在这台手机上，请用 session_message 联系它')
      return target.agentUserId
    }
    if (/^gugu:\d+$/.test(address)) {
      const { data, error } = await cloud.identity.from('users').select('id').eq('gugu_number', Number(bare(address, 'gugu'))).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'recipient')
    }
    throw new Error('收件人必须使用 user:、aid:、gugu: 或 session: 地址')
  }
  const members = async (id) => {
    const data = await cloud.rpc('chat', 'list_member_ids', { p_chat_id: id, p_as_user_id: agent.agentUserId })
    if (!Array.isArray(data)) throw new Error('聊天成员列表未返回列表')
    return data
  }
  const facts = async (id) => row(await cloud.rpc('chat', 'chat_facts', { p_chat_id: id, p_as_user_id: agent.agentUserId }))
  const rules = (id) => effectiveGroupRules(id, facts)
  const ledger = groupRulesLedgerFor(env)
  const beforeWrite = async (id, recipients = null) => {
    const membersHere = await members(id)
    if (!membersHere.some((member) => member.user_id === agent.agentUserId)) throw new Error('你不是这条聊天的成员；请用 message_conversations 确认可用聊天')
    const missing = (recipients ?? []).filter((uid) => !membersHere.some((member) => member.user_id === uid))
    if (missing.length) throw new Error(`收件人不在这条聊天中：${missing.map((uid) => `user:${uid}`).join('、')}。请调用 message_members 查有效成员。`)
    const current = await rules(id)
    if (current.trim() && (await ledger.read(agent.agentUserId, id))?.version !== groupRulesVersion(current)) throw new Error('发送前必须先调用 message_rules 阅读当前群规')
  }
  return { chats, chatId, userId, members, facts, rules, ledger, beforeWrite }
}

/** Reads always use the agent-as RPCs; the owner JWT never broadens the agent's history. */
export function phoneChatReadTools({ agent, cloud, store, env }) {
  const access = createPhoneChatAccess({ agent, cloud, store, env })
  const identityRows = async (ids) => {
    const all = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      const { data, error } = await cloud.identity.from('users').select('id,display_name,type,gugu_number').in('id', ids.slice(offset, offset + 50))
      if (error) throw new Error(error.message)
      all.push(...(data ?? []))
    }
    return new Map(all.map((user) => [user.id, user]))
  }
  const history = async (args, search = false) => {
    const id = await access.chatId(args.chat_id)
    const query = { p_chat_id: id, p_as_user_id: agent.agentUserId, p_before_seq: args.before_seq ?? null, p_limit: limited(args.limit) }
    if (args.before_seq !== undefined && !Number.isSafeInteger(args.before_seq)) throw new Error('before_seq 必须是消息返回的 seq 整数')
    const data = search
      ? await cloud.rpc('chat', 'message_search_as', { ...query, p_query: String(args.query ?? '') })
      : await cloud.rpc('chat', 'message_history_as', { ...query, p_thread_root_id: args.thread_root_id ? uuid(bare(args.thread_root_id, 'msg'), 'thread_root_id') : null })
    if (!Array.isArray(data)) throw new Error('消息历史未返回列表')
    return result(encodePhoneChatRows(data, true))
  }
  return [
    { name: 'message_conversations', label: '查看自己的聊天', description: '列出你作为这位 Agent 真正加入的私聊、群或话题，最近消息优先。返回 chat_id/public_id；用它们进入历史或发送，不要猜编号。', parameters: { type: 'object', properties: { ...listProperties, kind: { type: 'string', enum: ['dm', 'group', 'topic', 'ai'] }, pinned: { type: 'boolean' } } }, execute: async (_callId, args) => {
      const [rows, pins] = await Promise.all([access.chats(), cloud.chat.from('active_members').select('chat_id').eq('user_id', store.state.ownerId).eq('is_pinned', true)])
      if (pins.error) throw new Error(pins.error.message)
      const pinned = new Set((pins.data ?? []).map((item) => item.chat_id))
      const shown = rows.map((item) => ({ id: item.chat_id, chat_id: item.chat_id, public_id: item.public_id, kind: item.kind, status: item.status, name: item.name, pinned: pinned.has(item.chat_id), last_message_at: item.last_message_at, last_message_preview: item.last_message_preview }))
      return result(windowResult({ namesOf: (item) => [item.name], keep: (item, filter) => (!filter.kind || item.kind === filter.kind) && (filter.pinned === undefined || item.pinned === filter.pinned) }, shown, args))
    } },
    { name: 'message_members', label: '查看聊天成员', description: '按你这位 Agent 的可见域列聊天成员，返回可复用的 user: 地址、名字和咕咕号；按名字找人后再发送。', parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' }, ...listProperties, type: { type: 'string', enum: ['human', 'agent'] }, status: { type: 'string' } } }, execute: async (_callId, args) => {
      const members = await access.members(await access.chatId(args.chat_id))
      const identities = await identityRows(members.map((item) => item.user_id))
      const agentIds = members.filter((item) => identities.get(item.user_id)?.type === 'agent' && !store.state.agents[item.user_id]).map((item) => item.user_id)
      const presence = new Map()
      const unavailable = []
      for (let offset = 0; offset < agentIds.length; offset += 200) {
        try {
          const data = await cloud.rpc('identity', 'get_agent_presence_batch', { p_agent_user_ids: agentIds.slice(offset, offset + 200) })
          for (const id of agentIds.slice(offset, offset + 200)) if (data?.results?.[id]?.status === 'presence') presence.set(id, data.results[id].presence)
        } catch (error) { unavailable.push(`cloud presence: ${error.message}`) }
      }
      const rows = members.map((member) => {
        const user = identities.get(member.user_id)
        const local = store.state.agents[member.user_id]
        const published = presence.get(member.user_id)
        return { ...member, display_name: user?.display_name ?? null, type: user?.type ?? null, gugu_number: user?.gugu_number ?? null, is_self: member.user_id === agent.agentUserId,
          ...(local ? { status: local.status, detail: local.status === 'working' ? 'running' : null, status_from: 'this_machine' } : published ? { status: published.agent_status, detail: published.agent_status_detail, status_from: 'cloud', status_at: published.updated_at, host_online: published.device_status === 'online' ? true : published.device_status === 'offline' ? false : null } : {}) }
      }).sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')) || a.user_id.localeCompare(b.user_id))
      const directory = windowResult({ namesOf: (item) => [item.display_name], statusFilter: true, keep: (item, filter) => (!filter.type || item.type === filter.type) && matchesAgentStatus(item, filter.status) }, rows, args)
      if (unavailable.length) directory.status_unavailable = unavailable.join('; ')
      return result(encodePhoneChatRows(directory))
    } },
    { name: 'message_history', label: '读取消息历史', description: '按你自己的 Agent 身份读取一条聊天的主线或指定线程。使用返回的 seq 和 before_seq 翻页；隐藏历史和悄悄话由服务端按你的身份检查。', parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' }, thread_root_id: { type: 'string' } } }, execute: (_callId, args) => history(args) },
    { name: 'message_search', label: '搜索消息', description: '搜索这条聊天中你真正可读的消息，返回消息来源和 seq；按 before_seq 翻页。', parameters: { type: 'object', required: ['chat_id', 'query'], properties: { chat_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' } } }, execute: (_callId, args) => history(args, true) },
  ]
}
