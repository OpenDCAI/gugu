#!/usr/bin/env node
import { conversationLink, groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { resolveReplyDelivery } from '@gugu/core/shared/replyDelivery'
import { archivedDeliveryReceipt, messageDeliveryBlocks } from './message-delivery-blocks.mjs'

import { downloadSessionFile } from '@gugu/core/local/agent/sessionFileHandoff'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { z } from 'zod'
import { tokenizeMarkdownMath } from '../../../../packages/core/src/shared/markdownMath.mjs'
import { findRosterNameHits } from '../../../../packages/core/src/shared/rosterNameMatching.mjs'
import { findMentionSpans } from '../../../../packages/core/src/shared/mentionToken.mjs'
import { EXTENSION_ARCHIVE_MIME, isImageMimeType, resolveAttachmentMimeType } from '../../../../packages/core/src/shared/imageMime.mjs'
import { saveFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { decodeIdentityAddress, decodeTypedId, encodeTypedId } from '../../../../packages/core/src/shared/typedId.mjs'
import { workspaceUploadKind } from '../../../../packages/core/src/shared/workspaceUpload.mjs'
import { parseAttachmentContent } from '../../../../packages/core/src/shared/ui/attachmentModels'
import { attachmentFolderLine } from '../../../../packages/core/src/shared/attachmentFolderLine'
import { AttachmentsError, commitAttachment, sendFileAsOwner, uploadAttachmentBytes } from '../../../../packages/core/src/cloud/attachmentsApi'
import { createGroupWithInvitations } from '../../../../packages/core/src/cloud/groupChat'
import { createGroupAdmin, setGroupAvatar } from '../../../../packages/core/src/cloud/groupAdmin'
import { registerGuguTool } from './register-gugu-tool.mjs'
import { FORUM_TOOL_DEFS } from './gugu-forum-tools.mjs'
import {
  agentStatusFilterSchema,
  listWindowShape,
  matchesAgentStatus,
  pinnedFilterSchema,
  windowResult,
} from './list-window.mjs'
import { GUGU_MCP_SERVER_NAME } from './gugu-mcp-name.mjs'
import { chatActivityTool } from './chat-activity.mjs'
import { createLogger } from '../lib/logger'
import { effectiveGroupRules, groupRulesLedgerAt, groupRulesVersion } from '../../../../packages/core/src/local/agent/groupRulesDelivery'

const log = createLogger('gugu-mcp-host')

/**
 * @typedef {Object} GuguImContext
 * @property {string} supabaseUrl
 * @property {string} anonKey
 * @property {string} agentId
 * @property {string|null} threadRootId
 * @property {string} guguHome
 * @property {(signal?: AbortSignal) => Promise<string>} getAccessToken
 * @property {((action: object, signal?: AbortSignal) => Promise<unknown>)=} runHostAction
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── id 边界（id 收敛第三刀，见 typedId.mjs）─────────────────────────────────────────
// 存储层是裸 UUID；agent 看到的 identity id 一律 `user:<id>`（人和 agent 同表同列，一种标签），消息 id 一律
// `msg:<id>`。入参在 dispatchTool 解码（裸 id / 类型不符当场报错），出参在同一处按字段名编码。chat_id 不动：它
// 本就接受可读的 public_id。编解码只在这一处，双向强制。
const USER_ID_FIELDS = new Set([
  'actor_user_id', 'user_id', 'sender_user_id', 'owner_user_id', 'peer_user_id', 'friend_user_id', 'source_sender_user_id', 'agent_user_id',
  'creator_user_id', 'author_id', 'inviter_user_id', 'inviter_account_user_id', 'invitee_user_id', 'decision_user_id',
  'userId', 'agentUserId',
])
const USER_ID_LIST_FIELDS = new Set(['to_user_ids', 'member_user_ids'])
const MESSAGE_ID_FIELDS = new Set([
  'reply_to_message_id', 'thread_root_id', 'source_message_id', 'message_id', 'client_message_id',
])
const MESSAGE_ID_LIST_FIELDS = new Set(['source_message_ids'])
/** def.messageRows 的工具(history/search):行的 `id` 就是消息 id。集合从 TOOL_DEFS 派生,❌ 不再手维护侧表。 */
let MESSAGE_ROW_TOOLS = new Set()

function decodeIdList(kind, list, field) {
  if (list == null) return list
  if (!Array.isArray(list)) return list
  // Blank / non-string entries are left for the handler's own validation, whose messages name the
  // parameter contract; only real ids are decoded here.
  return list.map((value, index) =>
    typeof value === 'string' && value.trim() ? decodeTypedId(kind, value, `${field}[${index}]`) : value,
  )
}

/**
 * `to_user_ids` 收**三种** typed 地址,和 `session_message` 的 `to` 同一条链(#4631 把「收件人怎么写」
 * 统一成 typed address 时,这一格是唯一还只收裸 UUID 的;#5048 加上咕咕号短写法):
 *   · `user:<uuid>`  —— 当场解成裸 UUID(存储形态);
 *   · `gugu:<号>`    —— 语法在这儿验(`decodeIdentityAddress`,唯一入口),归一成 `gugu:<n>` 留到发送那一刻,
 *                      由 `identity.search_users` 解析成 canonical id(见 `resolveRecipientAddresses`);
 *   · `session:<id>` —— 原样留到发送那一刻,由宿主的本机名录解析成该会话的 canonical
 *                      `identity.users.id`(见 `resolveRecipientAddresses`)。
 * 为什么不在这儿解析:这一层是同步的 id 边界,而 `session:` 要问的那个身份是**发送那一刻**才
 * 一定存在的 —— spawn 刚落地时 child 还没供给身份,回执却必须现在就把地址交出去;`gugu:` 要问的是
 * 云端名录,同样是异步的。
 */
function decodeRecipientList(list, field) {
  if (list == null || !Array.isArray(list)) return list
  return list.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) return value
    const trimmed = value.trim()
    if (trimmed.startsWith('session:')) return trimmed
    const address = decodeIdentityAddress(trimmed, `${field}[${index}]`)
    return address.kind === 'user' ? address.id : `gugu:${address.number}`
  })
}

/**
 * 咕咕号 → identity 行。名录 = `identity.search_users`(与「添加好友」搜索同一条 SECURITY DEFINER RPC,
 * ❌ 不另开更宽的查人路径):人和公开 agent 都有号;未公开的 agent 没有号,也就找不到。RPC 还会按昵称
 * 子串命中别人,号只认相等。查不到就 fail loud —— 这是 `profile_lookup` 与 `gugu:` 寻址共用的唯一解析点。
 */
async function lookupGuguNumber(number, deps) {
  const rows = await deps.restRpc('search_users', { p_query: String(number) }, 'identity')
  let hit = (Array.isArray(rows) ? rows : []).find((row) => Number(row?.gugu_number) === number)
  if (!hit) {
    // search_users 按设计不返回调用者自己(`u.id <> auth.uid()`),而这里的 JWT 是 owner 的 ⇒ owner 自己的号
    // 在那条路上永远查不到 —— 可 owner 正是 agent 最常写的收件人(mac1 实测 2026-09-05:agent 给 owner
    // 发 gugu:<号> 被拒「not visible」)。补的只是「自己那一行」:按 JWT sub 精确读一行,❌ 不是更宽的查人路径。
    const me = parseJwtPayload(await deps.context.getAccessToken())?.sub
    if (typeof me === 'string' && me) {
      const own = await deps.restGet(
        `users?id=eq.${enc(me)}&gugu_number=eq.${number}&select=id,display_name,type,gugu_number,agent_public`,
        'identity',
      )
      // 只认「就是自己这一行、号相等」:别的行一概不算命中(这条路的合同就是这么窄)。
      hit = (Array.isArray(own) ? own : []).find((row) => row?.id === me && Number(row?.gugu_number) === number)
    }
  }
  if (!hit) {
    throw new Error(`no person or public agent with Gugu number ${number} is visible to you (unassigned, private, or mistyped)`)
  }
  return hit
}

/** `profile_lookup` 的入参:数字,或 typed 身份短址(agent 从信封 / 名录里抄来的原样)。 */
function guguNumberArg(value) {
  if (typeof value === 'string' && value.trim().startsWith('gugu:')) {
    return decodeIdentityAddress(value, 'gugu_number').number
  }
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('gugu_number must be a positive integer, or the typed address gugu:<number>')
  }
  return number
}

function userIdArg(value) {
  const address = decodeIdentityAddress(value, 'gugu_number')
  if (address.kind !== 'user' || !UUID_RE.test(address.id)) {
    throw new Error('gugu_number user:<uuid> address must contain a canonical identity UUID')
  }
  return address.id
}

function friendUserIdArg(value) {
  const address = decodeIdentityAddress(value, 'friend_user_id')
  if (address.kind !== 'user' || !UUID_RE.test(address.id)) {
    throw new Error('friend_user_id must be the canonical user:<uuid> address from owner_friends_list')
  }
  return address.id
}

async function lookupUserId(id, deps) {
  const rows = await deps.restGet(
    `users?id=eq.${enc(id)}&select=id,display_name,type,gugu_number,agent_public`,
    'identity',
  )
  const matches = Array.isArray(rows) ? rows.filter((row) => row?.id === id) : []
  if (matches.length !== 1) {
    throw new Error(`no person or agent with user address user:${id} is visible to you`)
  }
  return matches[0]
}

/**
 * `session:<id>` → 那条会话的 canonical `identity.users.id`(裸 UUID)。
 *
 * ⛔ **落库的必须是裸 UUID。** 悄悄话可见性(chat.message_visible_to)拿 `<uuid> = ANY(to_user_ids)` 直接判;
 * 一旦把 typed id 写进那一列,那条查询会**静默**查不到,症状长得像「消息没送到」。所以解析发生在
 * 建 row **之前**,row 里再也见不到 typed 形态。
 *
 * 解析源是宿主的本机会话名录(`session_peers` 同一条 host action):它按 conversationId 给出
 * canonical id。查不到就 fail loud —— ❌ 不静默丢掉一个收件人,那正好是「发了但没人醒」。
 */
export async function resolveRecipientAddresses(list, deps, field = 'to_user_ids') {
  if (!Array.isArray(list)) return list
  const needsSessions = list.some((v) => typeof v === 'string' && v.startsWith('session:'))
  const needsNumbers = list.some((v) => typeof v === 'string' && v.startsWith('gugu:'))
  if (!needsSessions && !needsNumbers) return list
  const byConversation = new Map()
  if (needsSessions) {
    if (!deps.context.runHostAction) {
      throw new Error(`${field}: session:<id> addressing needs the local session host bridge, which this caller has none of; pass user:<uuid> or gugu:<number> (from message_members) instead`)
    }
    const peers = await deps.context.runHostAction({ action: 'peers' })
    for (const row of Array.isArray(peers) ? peers : []) {
      const conversationId = row?.sessionId
      const userId = row?.identity?.users?.id
      if (typeof conversationId === 'string' && typeof userId === 'string' && userId) {
        byConversation.set(conversationId, userId)
      }
    }
  }
  // #5048 咕咕号短址:一号一次名录往返,同号去重;号不存在在这里就响,❌ 不静默丢掉一个收件人。
  const byNumber = new Map()
  if (needsNumbers) {
    const numbers = new Set(
      list.filter((v) => typeof v === 'string' && v.startsWith('gugu:')).map((v) => decodeIdentityAddress(v, field).number),
    )
    for (const number of numbers) byNumber.set(number, (await lookupGuguNumber(number, deps)).id)
  }
  return list.map((value, index) => {
    if (typeof value !== 'string') return value
    if (value.startsWith('session:')) {
      const conversationId = decodeTypedId('session', value, `${field}[${index}]`)
      const userId = byConversation.get(conversationId)
      if (!userId) {
        throw new Error(
          `${field}: ${value} is not an addressable session on this machine — it has no gugu identity yet (a just-spawned child gets one as it starts up) or it was deleted. ` +
          `session_peers lists what is addressable; message_members lists this chat's members as user:<uuid> with their gugu_number.`
        )
      }
      if (!UUID_RE.test(userId)) throw new Error(`${field}: host resolved ${value} to a non-UUID identity ${JSON.stringify(userId)}`)
      return userId
    }
    if (value.startsWith('gugu:')) {
      const userId = byNumber.get(decodeIdentityAddress(value, `${field}[${index}]`).number)
      if (!UUID_RE.test(userId)) throw new Error(`${field}: 咕咕号 lookup resolved ${value} to a non-UUID identity ${JSON.stringify(userId)}`)
      return userId
    }
    return value
  })
}

/** agent → host: typed ids back to storage form; bare ids and wrong kinds fail loud by parameter name. */
function decodeImArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const out = { ...args }
  for (const field of USER_ID_LIST_FIELDS) {
    // The direct callTool route sees the raw protocol value; a JSON-serialized array is accepted there
    // exactly as the SDK schema's preprocess accepts it, so it is normalized before its ids are decoded.
    if (!(field in out)) continue
    const normalized = normalizeRecipientInput(out[field])
    out[field] = field === 'to_user_ids'
      ? decodeRecipientList(normalized, field)
      : decodeIdList('user', normalized, field)
  }
  for (const field of MESSAGE_ID_FIELDS) {
    if (typeof out[field] === 'string' && out[field].trim()) out[field] = decodeTypedId('msg', out[field], field)
  }
  for (const field of MESSAGE_ID_LIST_FIELDS) {
    if (field in out) out[field] = decodeIdList('msg', out[field], field)
  }
  return out
}

function encodeIdIfBare(kind, value) {
  return typeof value === 'string' && value && !value.includes(':') ? encodeTypedId(kind, value) : value
}

function encodeImValue(value, { messageRows }) {
  if (Array.isArray(value)) return value.map((item) => encodeImValue(item, { messageRows }))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (USER_ID_FIELDS.has(key)) out[key] = encodeIdIfBare('user', entry)
    else if (USER_ID_LIST_FIELDS.has(key) && Array.isArray(entry)) out[key] = entry.map((v) => encodeIdIfBare('user', v))
    else if (MESSAGE_ID_FIELDS.has(key)) out[key] = encodeIdIfBare('msg', entry)
    else if (MESSAGE_ID_LIST_FIELDS.has(key) && Array.isArray(entry)) out[key] = entry.map((v) => encodeIdIfBare('msg', v))
    else if (key === 'id' && messageRows) out[key] = encodeIdIfBare('msg', entry)
    else if (key === 'identity' && entry && typeof entry === 'object' && entry.users && typeof entry.users === 'object') {
      // session_peers rows group the canonical identity under identity.users.id — same key, same tag.
      out[key] = { ...entry, users: { ...entry.users, id: encodeIdIfBare('user', entry.users.id) } }
    }
    else out[key] = encodeImValue(entry, { messageRows })
  }
  return out
}

/** host → agent: encode ids in whatever the handler returned (JSON text, or the `sent (id=…)` receipt). */
function encodeImOutput(name, args, out) {
  if (typeof out !== 'string') return out
  const messageRows = MESSAGE_ROW_TOOLS.has(name)
  const trimmed = out.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(encodeImValue(JSON.parse(trimmed), { messageRows }))
    } catch {
      return out
    }
  }
  return out.replace(/\(id=([0-9a-f-]{36})\)/gi, (_m, id) => `(id=${encodeTypedId('msg', id)})`)
}

// ── Supabase REST / Storage 原语（profile 选 schema：chat / identity） ──
function restHeaders(context, accessToken, profile, extra = {}) {
  const h = {
    apikey: context.anonKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...extra,
  }
  if (profile) {
    h['Accept-Profile'] = profile
    h['Content-Profile'] = profile
  }
  return h
}
export async function restGet(context, path, profile = 'chat', fetchImpl = fetch) {
  const accessToken = await context.getAccessToken()
  let res
  try {
    res = await fetchImpl(`${context.supabaseUrl}/rest/v1/${path}`, {
      headers: restHeaders(context, accessToken, profile),
    })
  } catch (error) {
    if (error instanceof RpcHttpError) throw error
    const status = Number(error?.status)
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      throw new RpcHttpError(status, { accessToken })
    }
    if (error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new RpcTransportError()
    }
    throw error
  }
  if (!res.ok) {
    const detail = rpcErrorDetail(await res.text().catch(() => ''))
    throw new RpcHttpError(res.status, { accessToken, detail })
  }
  return res.json()
}
async function restInsert(context, table, row, profile = 'chat', fetchImpl = fetch) {
  const accessToken = await context.getAccessToken()
  const res = await fetchImpl(`${context.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: restHeaders(context, accessToken, profile, { Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  })
  if (!res.ok) throw new Error(`INSERT ${table} → ${res.status} ${await res.text()}`)
}
async function restPatch(context, path, body, profile = 'chat', fetchImpl = fetch, returning = false) {
  const accessToken = await context.getAccessToken()
  const res = await fetchImpl(`${context.supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: restHeaders(context, accessToken, profile, { Prefer: returning ? 'return=representation' : 'return=minimal' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${await res.text()}`)
  return returning ? res.json() : undefined
}
export async function restRpc(context, name, body, profile = 'chat', fetchImpl = fetch) {
  const accessToken = await context.getAccessToken()
  let res
  try {
    res = await fetchImpl(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: restHeaders(context, accessToken, profile),
      body: JSON.stringify(body || {}),
    })
  } catch (error) {
    if (error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new RpcTransportError()
    }
    throw error
  }
  if (!res.ok) {
    const detail = rpcErrorDetail(await res.text().catch(() => ''))
    throw new RpcHttpError(res.status, { accessToken, detail })
  }
  // void RPC → PostgREST 回空 body(204)；空 body 上
  // res.json() 会抛 "Unexpected end of JSON input"。容忍空 body 回 null（#1216 secretary 实测抓到）。
  const t = await res.text()
  return t ? JSON.parse(t) : null
}

export class RpcTransportError extends Error {
  constructor() { super('command RPC transport failed') }
}

export class RpcHttpError extends Error {
  // @@@5856 detail 是**服务端那句人话**。create_topic 一条路上就有 8 个前置判据(悄悄话 / 已撤回 /
  // 不在那条 chat 里 / 来源是另一条话题 / 主人和 agent 都不在来源线 …),每条都专门写了给 agent 看的
  // 解释 —— 原先响应体读出来直接扔掉,agent 一律只收到 `command RPC HTTP 400`,
  // 既不知道该换消息、换 chat,还是别再试,只能重试或放弃。
  // ❗鉴权重试只看 status,不看 message,所以拼进去不影响那条路径。
  constructor(status, options = {}) {
    const detail = typeof options.detail === 'string' ? options.detail.trim() : ''
    super(detail ? `command RPC HTTP ${status}: ${detail}` : `command RPC HTTP ${status}`)
    this.status = status
    this.detail = detail || undefined
    this.authRetryAttempted = options.authRetryAttempted === true
    this.accessToken = options.accessToken
  }
}

// PostgREST 的错误体是 {message,details,hint,code};RAISE EXCEPTION 的正文落在 message。
// 非 JSON(网关 502 之类)就退回原始文本,截断以免把一整页 HTML 塞进 agent 的上下文。
function rpcErrorDetail(raw) {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    const parts = [parsed?.message, parsed?.details, parsed?.hint].filter((x) => typeof x === 'string' && x.trim())
    if (parts.length > 0) return parts.join(' — ').slice(0, 600)
  } catch { /* 不是 JSON,按原始文本处理 */ }
  return String(raw).slice(0, 600)
}

// The attachments function (core's one client, packages/core/src/cloud/attachmentsApi.ts): this session's server and token.
async function attachmentsEndpoint(context, fetchImpl = fetch) {
  return { supabaseUrl: context.supabaseUrl, anonKey: context.anonKey, token: await context.getAccessToken(), fetch: fetchImpl }
}
// 鉴权失效只允许读取一次 host fresh token；transport/5xx 在 post helper 内按稳定 row 有界重试。
function isRefreshableAuthError(err) {
  return err instanceof RpcHttpError && err.status === 401 && !err.authRetryAttempted
}
// 构造稳定 chat.messages 行；RPC 响应丢失时原样重放，由数据库逐字段幂等校验。
function buildMessageRow(context, {
  id,
  chatId,
  content,
  contentType,
  toUserIds,
  replyToMessageId,
  threadRootId,
  isThreadRoot,
  isWhisper,
}) {
  return {
    id,
    chat_id: chatId,
    sender_user_id: context.agentId,
    content: String(content ?? ''),
    content_type: contentType || 'text',
    client_message_id: id,
    reply_to_message_id: replyToMessageId ?? null,
    to_user_ids: toUserIds ?? null,
    thread_root_id: threadRootId ?? context.threadRootId ?? null,
    is_thread_root: isThreadRoot === true,
    ...(isWhisper ? { is_whisper: true } : {}),
  }
}

function messageHistoryPage(deps, chatId, { asUserId = deps.context.agentId, threadRootId = null, beforeSeq = null, limit = 20 } = {}) {
  return deps.restRpc('message_history_as', { p_chat_id: chatId, p_as_user_id: asUserId,
    p_thread_root_id: threadRootId, p_before_seq: beforeSeq, p_limit: limit })
}

async function replySourceOf(deps, chatId, messageId, threadRootId) {
  let beforeSeq = null
  for (;;) {
    const rows = await messageHistoryPage(deps, chatId, { threadRootId, beforeSeq, limit: 100 })
    const source = rows.find((message) => message.id === messageId)
    if (source) {
      if (typeof source.is_whisper !== 'boolean') throw new Error('message_send: message_history_as must return is_whisper; update the backend')
      return source
    }
    if (rows.length < 100) throw new Error('message_send: reply source is unavailable in this chat for the current agent')
    const next = Number(rows[rows.length - 1].seq)
    if (!Number.isSafeInteger(next) || (beforeSeq !== null && next >= beforeSeq)) throw new Error('message_send: reply history cursor did not advance')
    beforeSeq = next
  }
}

function createSessionState() {
  return {
    chatKinds: new Map(),
    // @@@3643 群规已读状态:chatId → 读到过的那一版群规原文。❌ 不能像 chatKinds 那样记忆化群规本身
    // (kind 终身不变,群规会改);这里只记「我读过的是哪一版」,发送时拿当前版比对。
    readGroupRules: new Map(),
    // 入群事实只应随该 MCP session 的第一次 rules 查询展示一次；事实本身由数据库 RPC 提供。
    joinContextShown: new Set(),
    // 话题 → 它的来源线。与 chatKinds 同理:溯源指针建立时写死、终身不变,可以记忆化。
    topicSources: new Map(),
  }
}

function createDeps(context, injected = {}, state = createSessionState()) {
  const fetchImpl = injected.fetch ?? fetch
  return {
    restGet: (path, profile) => restGet(context, path, profile, fetchImpl),
    restInsert: (table, row, profile) => restInsert(context, table, row, profile, fetchImpl),
    restPatch: (path, body, profile) => restPatch(context, path, body, profile, fetchImpl),
    restPatchReturning: (path, body, profile) => restPatch(context, path, body, profile, fetchImpl, true),
    restRpc: (name, body, profile) => restRpc(context, name, body, profile, fetchImpl),
    uploadGroupAvatar: async (path, file) => {
      const token = await context.getAccessToken()
      const storagePath = path.split('/').map(encodeURIComponent).join('/')
      const base = context.supabaseUrl.replace(/\/$/, '')
      const res = await fetchImpl(`${base}/storage/v1/object/chat-media/${storagePath}`, {
        method: 'POST', headers: restHeaders(context, token, null, { 'Content-Type': file.type, 'x-upsert': 'false' }), body: file,
      })
      if (!res.ok) throw new Error(`Group avatar upload failed: ${res.status} ${await res.text()}`)
      return `${base}/storage/v1/object/public/chat-media/${storagePath}`
    },
    attachmentsEndpoint: () => attachmentsEndpoint(context, fetchImpl),
    resolveFile: (ref, actor = context.agentId) => {
      if (!context.resolveFile) throw new Error('Verified file resolver is not installed')
      return context.resolveFile(ref, actor)
    },
    ...injected,
    context,
    state,
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────
const enc = encodeURIComponent

// 一条 URL 里带的 id 数上限。共享测试库网关实测:`id=in.(…)` 带 80 个 UUID 通、100 个回 502 Bad Gateway
// (2026-09-26 mac1;边界的来历见 packages/core/src/shared/inChunks.ts 的 @@@in-filter-budget)。大群、好友多的主人都会越过它。
export const IN_LIST_BATCH = 50

/**
 * 按 ≤IN_LIST_BATCH 个 id 一批并发读,结果拼成一张表。`readBatch(batch)` 自己拼那一批的 URL。
 * ❌ 把整张 id 列表拼进一条 URL;❌ 改成不带 id 的整表读(撞 PostgREST 每次响应的行数上限,静默少行)。
 */
async function restGetInBatches(ids, readBatch) {
  const batches = []
  for (let i = 0; i < ids.length; i += IN_LIST_BATCH) batches.push(ids.slice(i, i + IN_LIST_BATCH))
  const results = await Promise.all(batches.map((batch) => readBatch(batch)))
  return results.flatMap((rows) => (Array.isArray(rows) ? rows : []))
}

// 参数说明会随每个工具重复一遍,只写这一格独有的事;「目标从不推断」这类通用规则在平台提示词里讲一次。
// chat_id 从哪来(投递信封的 chat=,或 public_id)只在 message_send 的 chat_id 上讲一次:每个列出的工具都重复同一句时,
// 开场为它付 ≈200 token(上下文工程第一批 P5,2026-10-07 实测)。
const CHAT_ID_DESCRIPTION = 'The target chat: the chat= value from your gugu_delivery envelope, a public_id, or your owner\'s address for your private chat with them.'
const chatIdSchema = z.string().trim().min(1)

/**
 * @@@owner-address-is-dm — chat_id 写主人的身份地址 = 和主人的私聊(#7351)。会话页 agent 默认没有这条私聊
 * (@@@no-auto-dm),它真要对主人说话的那一刻才开。这条 server 拿的是主人的 JWT ⇒ `open_dm(本 agent)` 开出来的
 * 就是主人 ↔ 本 agent 那一条,与主人在界面上点开同一个 RPC、同一形态;已有就是那条(幂等)。
 * 只认主人:别人的地址不是一个 chat,参数恒为本 agent 自己,开不出任何别人的私聊。
 */
async function ownerDirectChatId(address, deps) {
  const decoded = decodeIdentityAddress(address, 'chat_id')
  const userId = decoded.kind === 'user' ? decoded.id : (await lookupGuguNumber(decoded.number, deps)).id
  if (userId !== await currentAuthUserId(deps)) {
    throw new Error(`chat_id ${address} is not a chat: an identity address works here only for your owner (your private chat with them); for anyone else use an id from message_conversations`)
  }
  const chatId = await deps.restRpc('open_dm', { p_target_user_id: deps.context.agentId })
  if (typeof chatId !== 'string' || !UUID_RE.test(chatId)) throw new Error('open_dm returned no chat for your owner')
  return chatId
}

async function resolveChatIdInput(chatId, deps) {
  if (UUID_RE.test(String(chatId))) return String(chatId)
  const publicId = String(chatId ?? '').trim()
  if (!publicId) return null
  if (/^(aid|user|gugu):/.test(publicId)) return await ownerDirectChatId(publicId, deps)
  // Production public_id values are numeric. Preserve non-production/internal opaque ids
  // used by injected callers; the schema description still directs agents to UUID ids.
  if (!/^\d+$/.test(publicId)) return publicId
  const rows = await deps.restGet(`chats?public_id=eq.${enc(publicId)}&select=id,public_id`)
  if (rows.length === 1 && UUID_RE.test(String(rows[0]?.id))) return rows[0].id
  if (rows.length > 1) {
    throw new Error(`chat_id ${publicId} is ambiguous as public_id; use the UUID from message_conversations (id)`)
  }
  throw new Error(`chat_id ${publicId} looks like a public_id, but no conversation matched it; use the UUID from message_conversations (id)`)
}

async function requireChat(args, deps) {
  const explicit = args && typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
  if (explicit) return await resolveChatIdInput(explicit, deps)
  throw new Error('chat_id is required; the gugu MCP server never infers a conversation target')
}
function normalizeRecipientInput(v) {
  if (typeof v !== 'string') return v
  const trimmed = v.trim()
  if (!trimmed) return v
  if (!trimmed.startsWith('[')) return v
  try {
    return JSON.parse(trimmed)
  } catch {
    return v
  }
}
function normToList(v) {
  const normalized = normalizeRecipientInput(v)
  if (normalized == null) return null
  if (!Array.isArray(normalized)) throw new Error('to_user_ids must be an array of canonical identity.users.id UUIDs')
  if (!normalized.length) return null
  if (!normalized.every((uid) => typeof uid === 'string' && uid.trim())) {
    throw new Error('to_user_ids must be an array of canonical identity.users.id UUIDs')
  }
  return normalized
}
function clampLimit(v, def, lo, hi) {
  return Math.min(Math.max(lo, Number(v) || def), hi)
}
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
// 附件叫什么：默认就是磁盘上那个文件名，要改名才传 file_name。
// 传了路径还要求再手打一遍文件名是多余的，而多余的那一遍正是打错字的地方。
export function resolveUploadName(args) {
  const explicit = typeof args?.file_name === 'string' ? args.file_name.trim() : ''
  if (explicit) return explicit
  const fromPath = basename(String(args?.file_path || '').trim())
  return fromPath || 'file'
}
// 读要上传的文件。入参是路径，不是内容——服务端自己读盘，字节从不经过调用方。
// 这里原先收的是 content_base64，而 MCP 工具的调用方就是模型：它得把整串编码逐 token
// 复制一遍，漂一次后面全部错位，base64 解码又不报错，于是坏文件静默发出去（#5828 实测
// 16 KB 的文件毁掉 60%）。该参数已整个去掉，不留这条路。
export async function readUploadBytes(label, args, maxBytes) {
  const filePath = typeof args?.file_path === 'string' ? args.file_path.trim() : ''
  if (!filePath) throw new Error(`${label}: file_path is required`)
  if (!isAbsolute(filePath)) throw new Error(`${label}: file_path must be absolute, got ${filePath}`)
  const target = resolvePath(filePath)
  let info
  try {
    info = await stat(target)
  } catch (err) {
    throw new Error(`${label}: cannot read ${target} (${err?.code || err?.message || 'unknown'})`)
  }
  if (!info.isFile()) throw new Error(`${label}: ${target} is not a file`)
  if (info.size > maxBytes) throw new Error(`${label}: file exceeds ${maxBytes} bytes`)
  const buf = await readFile(target)
  // 读盘期间被换掉就不传——宁可响亮失败，也别传一份说不清是什么的东西出去。
  if (buf.length !== info.size) throw new Error(`${label}: ${target} changed while reading`)
  return buf
}
function parseJwtPayload(token) {
  const part = String(token || '').split('.')[1]
  if (!part) return null
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}
async function currentAuthUserId(deps) {
  const sub = parseJwtPayload(await deps.context.getAccessToken())?.sub
  if (typeof sub === 'string' && sub) return sub
  throw new Error('workspace write requires an authenticated owner token with a JWT sub')
}

// ── 群文件(#6492)── agent 碰群文件夹,只经 chat.workspace_*_as:按 **agent 自己**是不是来源群/私聊的成员判,
// created_by 写 agent。❌ 以主人的 JWT 直读直写 workspace_items —— 那是主人的可见域,agent 不在的群也读得到。
// 读写文件本身是群文件夹 App 的工具(preinstalled-apps/workspace/folder.mjs);这里只剩 App 平台以 agent 身份做的两件事:
// app_install 的数据文件(groupDataFileOf)、app_check 的范围(extensionCheckScopeOf)。
// CI 闸 scripts/check-im-server-direct-access.mjs 钉着:本文件不许出现 workspace_items 的 REST 路径。
async function workspaceRpcRows(deps, name, body, label) {
  const rows = await deps.restRpc(name, { ...body, p_as_user_id: deps.context.agentId })
  if (!Array.isArray(rows)) throw new Error(`${label}: ${name} returned a non-list result`)
  return rows
}
async function workspaceRpcItem(deps, name, body, label) {
  const [item] = await workspaceRpcRows(deps, name, body, label)
  if (!item) throw new Error(`${label}: ${name} returned no row`)
  return item
}

/**
 * F10 A workspace file as a chat link, handed over whole: in a message it shows as that file, and opening it there
 * opens it the way the workspace does (its App by claim). ❌ 别让 agent 自己拼 scheme 和 id —— 拼错一次就是一条打不开的链接。
 * F112 Only the item's id: it is unique, and the host finds its group from it.
 */
export function workspaceFileLink(item) {
  const name = String(item.filename ?? '').replace(/[[\]\\]/g, (c) => `\\${c}`)
  return `[${name}](${groupFileLink(item.id)})`
}
function summarizeWorkspaceItem(item) {
  return {
    id: item.id,
    chat_id: item.chat_id,
    kind: item.kind,
    filename: item.filename,
    content_type: item.content_type,
    size_bytes: item.size_bytes ?? null,
    pointer: item.pointer ?? null,
    source_message_ids: item.source_message_ids ?? [],
    created_by: item.created_by,
    version: item.version,
    created_at: item.created_at,
    updated_at: item.updated_at,
  }
}

// #849：whisper 的 to_user_ids 必须都是该 chat 的成员，否则拒绝——不假装投递成功（fail-loud）。
// 纯函数（无 I/O）：返回不在成员集里的收件人列表，便于单测。
export function recipientsNotInMembers(memberIds, toUserIds) {
  const members = new Set(memberIds)
  return (toUserIds || []).filter((uid) => !members.has(uid))
}
/**
 * 「我自己在的那条线」的成员名单只有一个诚实的形态:**非空数组**——我自己就在里面。
 * 所以「不是数组」(restRpc 对 void/空 body 回 null,见 #1216)与「零行」都只可能是**读不到**,
 * ❌ 不许当成空集:当成空集会把「我这一读没拿到」说成「这些人不是成员」,那是与事实相反的一句话,
 * agent 会照着它去改用别的线;当成全集则是另一头,直接把非成员放进收件人。两头都要 fail-loud。
 * ⚠️ 只用于「调用者必在其中」的路径;来源线、别人的线那种本就可能读到零行的地方用裸读(见各处注释)。
 */
async function memberRowsOfMyChat(chatId, deps) {
  const rows = await deps.restRpc('list_member_ids', { p_chat_id: chatId, p_as_user_id: deps.context.agentId })
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(
      `读不到 chat(${chatId})的成员名单。这不是「这条线没有成员」——你自己就在里面——而是这一读没拿到。`
      + '重试一次;仍然如此说明这条线现在对你不可见,换用 message_conversations 确认你还在不在里面。'
    )
  }
  return rows
}
/**
 * F15 app_install / app_pack { chat_id }: the packed .guguext goes into that group as an extension card in
 * the same call — message_send_file's own path (group rules, size, the attachment message), sent as this agent.
 *
 * F31 (L5 S1, third round): an agent reinstalling with chat_id sent a second card of the same version. A card is one
 * version of one App: when the group already has this App's card of this version (`<id>-<version>.guguext`), none is
 * sent and its message is answered instead — `alreadyThere`. When that card holds other bytes (the App changed and
 * its version did not), `differs`: a second card of the same version would not reach anyone who has the first.
 * Ids come back bare: the tool layer types them once (sessionpage-tool-registrar encodes `message_id`).
 */
export async function sendExtensionCardOf(context, { chatId, filePath, fileName, sha256 }, injected = {}) {
  const deps = createDeps(context, injected)
  const chat = await requireChat({ chat_id: String(chatId) }, deps)
  const existing = await extensionCardIn(deps, chat, fileName)
  if (existing) {
    // Its bytes decide whether it is this App; a card that cannot be fetched is answered as there, contents unknown
    // (differs: null) — never a second card on a guess. A new card's link is signed as this agent (#7290).
    const differs = await deps.resolveFile({ message_id: existing.id }).then(async file => {
      if (file.status !== 'ready') return null
      try { for await (const _chunk of file.stream()) { /* Authenticate the entire original before comparing. */ } return file.revision.sha256 !== String(sha256) }
      finally { await file.dispose() }
    }).catch(() => null)
    return { messageId: existing.id, alreadyThere: true, differs }
  }
  // No mime_type: the .guguext name gives the extension archive type, which is what makes the chat draw a card.
  const out = await handleFile({ action: 'send-file', chat_id: chat, file_path: filePath, file_name: fileName }, deps)
  const id = String(JSON.parse(out).message_id ?? '').replace(/^msg:/, '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`the card was not sent (${out})`)
  return { messageId: id, alreadyThere: false, differs: false }
}

/**
 * F40 app_install { chat_id, data }: the group's data file, made as this agent — or the one already there with
 * that name (a reinstall after a fix keeps the group's data), or (F102, `itemId`) a document already in the group,
 * opened as it is. Judged by the same rule as an upload
 * (`workspaceUploadKind`): a `.json` must be a JSON object, and every data file is a live document.
 */
export async function groupDataFileOf(context, { chatId, name, content, itemId }, injected = {}) {
  const deps = createDeps(context, injected)
  const chat = await requireChat({ chat_id: String(chatId) }, deps)
  // 摩擦单 F102 (S20): the data is already in the group — that file itself, read as this agent; never a copy of it.
  if (itemId !== undefined) {
    const item = await workspaceRpcItem(deps, 'workspace_get_as', { p_item_id: String(itemId) }, 'app_install')
    if (String(item.chat_id) !== chat) throw new Error(`data.item_id ${itemId} is a file of another chat, not ${chatId}`)
    if (item.kind !== 'document') throw new Error(`data.item_id ${itemId} (${item.filename}) is a stored file, not a document an App opens`)
    return { item: summarizeWorkspaceItem(item), link: workspaceFileLink(item), reused: true }
  }
  // An App's data file is at the top (子文件夹): looked for there only, by the name as the database keeps names (`p_exact`:
  // its own rule, case not counted) — never worked out here.
  const [same] = await workspaceRpcRows(deps, 'workspace_list_as', {
    p_chat_id: chat, p_name: name, p_kind: 'document', p_folder: '', p_exact: true, p_offset: 0, p_limit: 1,
  }, 'app_install')
  if (same) return { item: summarizeWorkspaceItem(same), link: workspaceFileLink(same), reused: true }
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? {}, null, 2)
  const kind = workspaceUploadKind(name, null, new TextEncoder().encode(text))
  if (kind.kind !== 'document') throw new Error(`the data file ${name} was not made: ${kind.why}`)
  const item = await workspaceRpcItem(deps, 'workspace_create_document_as', {
    p_chat_id: chat,
    p_title: name,
    p_content: kind.text,
    p_content_type: kind.contentType,
    p_source_message_ids: [],
  }, 'app_install')
  return { item: summarizeWorkspaceItem(item), link: workspaceFileLink(item), reused: false }
}

/** The newest extension card named `fileName` in `chatId`, read as the owner (who is in every group its agent is). */
async function extensionCardIn(deps, chatId, fileName) {
  const rows = await deps.restGet(
    `messages?chat_id=eq.${enc(chatId)}&content_type=eq.attachment&content=like.${enc(`*${fileName}*`)}` +
      '&select=id,content,file_item_id,file_version,file_blob_id&order=created_at.desc&limit=20',
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const attachment = parseAttachmentContent(row.content, row)
    if (attachment?.fileName === fileName && resolveAttachmentMimeType(attachment.fileName, attachment.mimeType) === EXTENSION_ARCHIVE_MIME) {
      // A card whose file was deleted from the group folder holds nothing: not the card that is there.
      if (attachment.source.kind === 'gone') continue
      return { id: String(row.id), source: attachment.source }
    }
  }
  return null
}

/**
 * F5 app_check { chat_id?, item_id? }: the host runs the App as a hidden page in that group, on that file, and
 * hands the agent what the page shows — so only for a group this agent is in and a file of it the agent may read (the
 * workspace_*_as rule: the agent itself, not its owner). A file names its group; given both, they must agree.
 */
export async function extensionCheckScopeOf(context, { chatId, itemId }, injected = {}) {
  const deps = createDeps(context, injected)
  // L5 S1 rerun: an agent passed the group's public_id ("208920") and was told the file is in some other chat. chat_id
  // reads here the way every other tool reads it — one resolver — so either spelling of the same group is that group.
  const addressed = chatId ? await requireChat({ chat_id: String(chatId) }, deps) : null
  const chat = addressed ? (await topicSourceChatIdOf(deps, addressed)) ?? addressed : null
  if (itemId) {
    const item = await workspaceRpcItem(deps, 'workspace_get_as', { p_item_id: String(itemId) }, 'app_check')
    const itemChat = String(item.chat_id)
    if (chat && chat !== itemChat) {
      throw new Error(`app_check: file ${itemId} is in chat ${itemChat}, not ${chatId}; pass its item_id alone`)
    }
    return { chatId: itemChat, itemId: String(item.id ?? itemId) }
  }
  const members = await memberRowsOfMyChat(chat, deps)
  if (!members.some((row) => String(row.user_id) === context.agentId)) {
    throw new Error(`app_check: you are not in chat ${chatId}`)
  }
  return { chatId: chat }
}

/**
 * 这条消息 agent 自己看不看得见 —— 库里的 chat.can_read_message 按 agent 本人判(与 message_history 同一条
 * chat.message_visible_to:悄悄话只给发信人与收件人、成员的入群时间界)。主人令牌按 id 直读会放行主人看得见的一切,
 * 读到之后必须过这一道;❌ 在这里另写一份悄悄话规则。
 */
async function agentCanSee(deps, message, readerId = deps.context.agentId) {
  return (await deps.restRpc('can_read_message', { p_message_id: message.id, p_user_id: readerId })) === true
}

/**
 * #6646 app_install { source_message_id }: the host reads the message, and only for a chat this agent is in — the agent
 * names a message, never a URL. Who published it the install reads itself (app-identity.ts).
 */
export async function extensionAttachmentOf(context, messageId, injected = {}) {
  const deps = createDeps(context, injected)
  const [message] = await deps.restGet(`messages?id=eq.${enc(messageId)}&select=id,chat_id,content,file_item_id,file_version,file_blob_id`)
  if (!message || !(await agentCanSee(deps, message))) throw new Error(`app_install: there is no message ${messageId} you can read`)
  // The message was just read as the owner, so the owner is in that chat and its member list is never empty; an empty
  // read is a failed read, which memberRowsOfMyChat says loudly instead of calling it "not in the chat".
  const members = await memberRowsOfMyChat(message.chat_id, deps)
  if (!members.some((row) => String(row.user_id) === context.agentId)) {
    throw new Error(`app_install: you are not in the chat of message ${messageId}`)
  }
  const attachment = parseAttachmentContent(message.content, message)
  if (!attachment || resolveAttachmentMimeType(attachment.fileName, attachment.mimeType) !== EXTENSION_ARCHIVE_MIME) {
    throw new Error(`app_install: message ${messageId} has no .guguext attachment`)
  }
  if (attachment.source.kind === 'gone') throw new Error(`app_install: the package of message ${messageId} was deleted from the group folder`)
  // The message itself (#7290), old cards and new: the install reads it as the owner — its publisher is its sender (owner
  // 10-17), its bytes from attachments/urls — never from here, never a URL.
  return { message_id: String(message.id) }
}
async function assertRecipientsAreMembers(chatId, toUserIds, deps) {
  if (!toUserIds || !toUserIds.length) return
  const rows = await memberRowsOfMyChat(chatId, deps)
  const invalid = recipientsNotInMembers(rows.map((r) => r.user_id), toUserIds)
  if (invalid.length) {
    throw new Error(
      `收件人不在本 chat（${chatId}）成员里：${invalid.join(', ')}。用 message_members 查有效成员后重发。`
    )
  }
}

// Recipient ids and visible @mentions must express the same group routing decision.
export function reconcileMentionExpression(members, content, toUserIds, exemptIds = []) {
  const text = String(content ?? '')
  const declared = toUserIds || []
  const declaredSet = new Set(declared)
  const exempt = new Set(exemptIds)
  const named = members.filter((m) => m.display_name)
  const typedNames = new Set(findMentionSpans(text, named.map((m) => m.display_name)).map((span) => span.name))
  const mentioned = new Set(named.filter((m) => typedNames.has(m.display_name)).map((m) => m.id))
  const mentionsAll = findMentionSpans(text, ['all'], { ignoreCase: true }).length > 0
  const mismatches = named
    .filter((m) => mentioned.has(m.id) && !declaredSet.has(m.id) && !declaredSet.has('*') && !exempt.has(m.id))
    .map((m) => m.display_name)
  const prefixes = []
  if (declaredSet.has('*') && !mentionsAll) prefixes.push('@all')
  for (const uid of declared) {
    if (uid === '*' || mentioned.has(uid)) continue
    const m = named.find((x) => x.id === uid)
    if (m) prefixes.push('@' + m.display_name)
  }
  return { content: prefixes.length ? `${prefixes.join(' ')} ${text}` : text, mismatches }
}

// @@@3643 群规每次现取:它会被群主随时改,记忆化会让 agent 按一份作废的规矩行事。
/**
 * @@@5856 一条 chat 的基本事实(kind / 来源线 / 群规 / public_id),**按当前 agent 的身份**读。
 *
 * ⚠️ 为什么不能直连 REST:MCP 用的是**主人的** JWT,而 chats/chat_members 的策略判 auth.uid()。
 * agent 可以在主人不在的那条线上开话题(spec 允许,20260918235000 说这很常见)——
 * 那时主人读 chats 回 0 行,于是 topic_members 报「不是一条话题(kind=unknown)」这句假话,
 * 而投递侧照常把这条话题的消息叫醒它 ⇒ agent 被叫醒了却一个动作都做不了。
 * chat.chat_facts 是 SECURITY DEFINER 且收 p_as_user_id,判的是 agent 自己。
 *
 * ⚠️ **只缓存不变量**(kind / 来源线)。group_prompt 是群主随时能改的 —— 把它一起缓存下来,
 * 「群规中途改了要再拒一次」那条闸就永远拒不了第二次,agent 会按一份已作废的规矩继续说话。
 */
async function chatFactsOf(deps, chatId, { fresh = false } = {}) {
  if (fresh || !deps.state.chatFacts?.has(chatId)) {
    if (!deps.state.chatFacts) deps.state.chatFacts = new Map()
    const rows = await deps.restRpc('chat_facts', { p_chat_id: chatId, p_as_user_id: deps.context.agentId })
    const row = (Array.isArray(rows) ? rows[0] : rows) ?? null
    // ⚠️ @@@5856 找茬第九轮:**只缓存真拿到的那一行**。这条 RPC 对「此刻还读不到这条线的人」如实回 0 行,
    // 而它恰恰会在 agent 还没被拉进某话题时被调到。把那个 null 记进 Map 就是**终身**的:
    // 这个会话余生里这条线都是 unknown ⇒ topic_invite 永远抛「不是一条话题」、handleMessage 的
    // isGroupOrTopic 恒假(@ 一致性闸与裸名闸整条跳过,而那道闸在话题里更重要)、可点名集合按非话题算窄。
    // 「我这一读没拿到」不是「它不存在」——❌ 不把不知道写成知道。
    if (row !== null) deps.state.chatFacts.set(chatId, row)
    return row
  }
  return deps.state.chatFacts.get(chatId)
}

async function currentGroupRules(deps, chatId) {
  // 每次现读:群规是可变量(见 chatFactsOf 的注释)。话题自己没立规矩时沿用来源群的 —— 与投递读者
  // (agentInboxReader 的 #3641 群规送达)同一个判定,两边看到的「这条线的规矩」必须是同一份。
  return effectiveGroupRules(chatId, (id) => chatFactsOf(deps, id, { fresh: true }))
}

function groupRulesLedgerOf(deps) {
  if (deps.groupRulesLedger) return deps.groupRulesLedger
  const home = typeof deps.context.guguHome === 'string' ? deps.context.guguHome.trim() : ''
  if (!home) throw new Error('gugu MCP context has no guguHome; cannot read the group-rules delivery ledger')
  return groupRulesLedgerAt(joinPath(home, 'delivery', 'group-rules-delivered.json'))
}

/**
 * @@@3643/#3641 发送闸(兜底):群规的主通道是投递 —— 读者在这个 agent 的上下文里还没见过当前版本时,
 * 随投递把原文附上并落「已送达」记录。这道闸只拦「两条通道都没送到」的那种发言:
 *   · 投递已送达当前版本(落盘记录)⇒ 放行;
 *   · 本 MCP 会话里 message_rules 读过、或被这道闸拒过一次 ⇒ 放行;
 *   · 否则拒,同时把原文打出来并记为已读 ⇒ 重发一次即可通过,不会死循环。
 * 覆盖一切会往群里写消息的工具(message_send / message_send_file)。
 */
async function assertGroupRulesSeen(deps, chatId, toolName) {
  const groupRules = await currentGroupRules(deps, chatId)
  if (!groupRules) return
  if (deps.state.readGroupRules.get(chatId) === groupRules) return
  const delivered = await groupRulesLedgerOf(deps).read(deps.context.agentId, chatId)
  if (delivered?.version === groupRulesVersion(groupRules)) {
    deps.state.readGroupRules.set(chatId, groupRules)
    return
  }
  deps.state.readGroupRules.set(chatId, groupRules)
  throw new Error(
    `${toolName} 已拒:本群群主立了群规,而你还没见过当前这一版。规矩如下,读完把它纳入你要说的话,然后重发一次即可通过：\n\n` +
    `${groupRules}\n\n` +
    `(以后群规改了会再拒一次;想主动查随时用 message_rules)`
  )
}

function parseJoinContext(rows, chatId) {
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row || typeof row !== 'object') return null
  if (row.first_pull !== true) return null
  const joinedAt = typeof row.joined_at === 'string' && row.joined_at.trim() ? row.joined_at : null
  const skipped = Number(row.skipped_before_join)
  const beforeSeq = Number(row.before_seq)
  if (!joinedAt || !Number.isSafeInteger(skipped) || skipped <= 0 || !Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) {
    throw new Error('get_agent_join_context returned an invalid first-pull boundary')
  }
  return {
    joined_at: joinedAt,
    skipped_before_join: skipped,
    before_seq: beforeSeq,
    message_history: {
      tool: 'message_history',
      chat_id: chatId,
      before_seq: beforeSeq,
      hint: `You joined this group at ${joinedAt}. ${skipped} messages from before you joined were not delivered to you. `
        + `If you need that context, call message_history with { chat_id: "${chatId}", before_seq: ${beforeSeq} } before replying.`,
    },
  }
}

// chat kind 记忆化:kind 终身不变；缓存按显式目标 chat 分桶，不和当前回合或 session 绑定。
//
// ⚠️ @@@5856 找茬第九轮:**只缓存真拿到的那一行**。chat_facts 对「此刻还读不到这条线的人」返回 0 行,
// 而这个函数恰恰会在 agent 还没被拉进某话题时被调到(topic_invite 的前置检查)。
// 把那个 null 记进 Map 就是终身的:这个进程余生里这条线的 kind 都是 unknown ⇒
// topic_invite 永远抛「不是一条话题」、handleMessage 的 isGroupOrTopic 恒假(@ 一致性闸与裸名闸整条跳过,
// 而那道闸在话题里**更**重要)、addressableUserIds 按非话题处理(比服务端还严,正是它要避免的那个 bug)。
// 「我这一读没拿到」不是「它是 null」——❌ 不把不知道写成知道。
async function chatKindOf(deps, chatId) {
  if (deps.state.chatKinds.has(chatId)) return deps.state.chatKinds.get(chatId)
  const kind = (await chatFactsOf(deps, chatId))?.kind ?? null
  if (kind !== null) deps.state.chatKinds.set(chatId, kind)
  return kind
}

/**
 * 「这个 chat_id 真的是一条话题吗」。topic_* 这一域里,传错 id 的代价是静默回一份**别的线**的答案
 * (topic_list 要来源线 id、topic_members / topic_invite 要话题自己的 id,两者都是 uuid),
 * 所以每个只在话题上成立的动作都要先过这一关。
 */
async function assertIsTopic(args, deps, toolName) {
  const chatId = await requireChat(args, deps)
  const kind = await chatKindOf(deps, chatId)
  if (kind !== 'topic') {
    throw new Error(
      `${toolName}: chat_id ${chatId} 不是一条话题(kind=${kind ?? 'unknown'})。`
      + '这个动作只在话题里成立。用 topic_list(传**来源线**的 chat_id)找到话题自己的 chat_id 再试。'
    )
  }
  return chatId
}

/** 话题的来源线(溯源指针,建立时写死)。非话题回 null。 */
async function topicSourceChatIdOf(deps, chatId) {
  if (deps.state.topicSources.has(chatId)) return deps.state.topicSources.get(chatId)
  const row = await chatFactsOf(deps, chatId)
  // 同上:读不到那一行 = 这一读没拿到,❌ 不许把它记成「这条线没有来源」。
  if (!row) return null
  const sourceChatId = row.kind === 'topic' ? (row.source_chat_id ?? null) : null
  deps.state.topicSources.set(chatId, sourceChatId)
  return sourceChatId
}

/**
 * 这条线里「点得了名的人」= 它的成员;**话题另加来源线的成员** —— 点了名就把他拉进来
 * (BEFORE INSERT 触发器 `chat.join_topic_participants` 落实,见 20260918211500)。
 *
 * ⚠️ 判据必须与数据层 `chat.is_addressable_in` 同形。两侧不同形时,这道客户端闸会在前面拦掉数据层
 * 明明允许的动作,症状是「话题里永远拉不进人」而数据库一条错都没报 —— 闸比规则严,是同样的 bug。
 * 非话题零额外查询:群 / 私聊的可点名集合就是成员集合。
 */
async function addressableUserIds(deps, chatId, kind, memberRows) {
  const ids = new Set(memberRows.map((row) => String(row.user_id)))
  if (kind !== 'topic') return ids
  const sourceChatId = await topicSourceChatIdOf(deps, chatId)
  if (!sourceChatId) return ids
  // 这条**不**走 memberRowsOfMyChat:agent 未必在来源线里,零行在这里是合法答案。
  const sourceMembers = await deps.restRpc('list_member_ids',
    { p_chat_id: sourceChatId, p_as_user_id: deps.context.agentId })
  const rows = Array.isArray(sourceMembers) ? sourceMembers : []
  // ⚠️ 读到零行 = **我算不出来源线里有谁**,不是「来源线里没有人」(一条线至少有它的创建者)。
  // 这时候 ❌ 不许拿这个空集去拒人 —— 服务端的 chat.is_addressable_in 放行的是「话题成员 ∪ 来源线成员」,
  // 客户端据一个算不出来的集合去拒,就是闸比规则严:症状是话题里永远拉不进人,而数据库一条错都不报。
  // 返回 null 表示「这一关我判不了,交给服务端判」(调用方据此跳过本地 fail-loud)。
  if (!rows.length) return null
  for (const row of rows) ids.add(String(row.user_id))
  return ids
}

// ── 业务逻辑（每域一个 handler，按 action 分派；deps 可注入便于单测） ──
async function postCommandMessageRow(deps, row) {
  // S2b:发帖只有一条路 —— 稳定 id 直插 chat.messages(既有 spontaneous 生产路径;DB 逐字段幂等,
  // #2935)。per-turn lease/RPC 闸与 #2051「running deliver 拒绝无栅栏插入」随 push 模型整体退役:
  // 回哪个 chat 是 agent 显式携带 chat_id 的决定,归因不再依赖任何指针。
  await deps.restInsert('messages', row)
}

const KNOWN_TEX_COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi', 'rho', 'varrho', 'sigma',
  'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'mathbb', 'mathcal', 'mathbf', 'mathrm', 'mathit', 'mathsf', 'mathtt', 'operatorname',
  'text', 'texttt', 'textbf', 'frac', 'dfrac', 'tfrac', 'sqrt', 'begin', 'end', 'left', 'right',
  'middle', 'cap', 'cup', 'bigcap', 'bigcup', 'in', 'notin', 'ni', 'subset', 'subseteq', 'supset',
  'supseteq', 'setminus', 'neq', 'ne', 'equiv', 'cong', 'approx', 'sim', 'simeq', 'propto',
  'le', 'leq', 'ge', 'geq', 'to', 'mapsto', 'rightarrow', 'leftarrow', 'leftrightarrow',
  'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'hookrightarrow', 'times', 'cdot', 'pm', 'mp', 'div',
  'sum', 'prod', 'int', 'iint', 'iiint', 'oint', 'partial', 'nabla', 'infty', 'quad', 'qquad',
  'hspace', 'vspace', 'lVert', 'rVert', 'vert', 'Vert', 'angle', 'overline', 'underline', 'hat',
  'widehat', 'bar', 'vec', 'dot', 'ddot', 'min', 'max', 'lim', 'inf', 'sup', 'arg', 'det', 'dim',
  'ker', 'gcd', 'hom', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'Pr', 'Re',
  'Im', 'mod', 'pmod', 'bmod', 'forall', 'exists', 'neg', 'land', 'lor', 'wedge', 'vee', 'oplus',
  'otimes', 'langle', 'rangle',
])

const JSON_CONTROL_BY_ESCAPE_PREFIX = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
])
const DECODED_TEX_TAILS_BY_CONTROL = new Map()
for (const command of KNOWN_TEX_COMMANDS) {
  const control = JSON_CONTROL_BY_ESCAPE_PREFIX.get(command[0])
  if (!control || command.length < 2) continue
  const tails = DECODED_TEX_TAILS_BY_CONTROL.get(control) ?? []
  tails.push(command.slice(1))
  DECODED_TEX_TAILS_BY_CONTROL.set(control, tails)
}
for (const tails of DECODED_TEX_TAILS_BY_CONTROL.values()) {
  tails.sort((left, right) => right.length - left.length)
}
const DECODED_TEX_ORPHAN_PATTERNS = [
  /(?<!\\)\b(?:mathbb|mathcal|mathbf|mathrm)\s*(?:\{[A-Za-z0-9]+\}|[A-Z]\b)/,
  /(?<!\\)\b(?:operatorname|frac|sqrt)\s*\{/,
]

function isMathShapedDecodedContext(segment) {
  return segment.kind === 'math' || /[=^_{}]|\d\s*\/\s*\d/.test(segment.raw)
}

function decodedTexControlCorruption(text) {
  for (let index = 0; index < text.length; index += 1) {
    const tails = DECODED_TEX_TAILS_BY_CONTROL.get(text[index])
    if (!tails) continue
    for (const tail of tails) {
      const tailStart = index + 1
      if (!text.startsWith(tail, tailStart)) continue
      const next = text[tailStart + tail.length]
      if (next && /[A-Za-z]/.test(next)) continue
      return text.slice(index, tailStart + tail.length)
    }
  }
  return null
}

function decodedTexCorruptionOutsideMarkdownCode(text) {
  for (const segment of tokenizeMarkdownMath(text)) {
    if (segment.kind === 'code') continue
    const controlCorruption = decodedTexControlCorruption(segment.raw)
    if (controlCorruption) return [controlCorruption]
    if (!isMathShapedDecodedContext(segment)) continue
    for (const pattern of DECODED_TEX_ORPHAN_PATTERNS) {
      const match = segment.raw.match(pattern)
      if (match) return match
    }
  }
  return null
}

function windowsPathRanges(text) {
  const ranges = []
  const quotedPathPattern = /(["'])(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._$-]+\\)(?:[^\\\r\n"']+\\)*[^\\\r\n"']+\1/g
  for (const match of text.matchAll(quotedPathPattern)) {
    ranges.push({ start: match.index + 1, end: match.index + match[0].length - 1 })
  }

  const pathOpenerPattern = /[A-Za-z]:\\|\\\\[A-Za-z0-9._$-]+\\/g
  const compactPathCharacter = (character) => (
    Boolean(character) && !/[\s\\\r\n`<>:"/|?*,;]/.test(character)
  )
  const compactComponentEnd = (start) => {
    let cursor = start
    while (compactPathCharacter(text[cursor])) cursor += 1
    return cursor
  }

  for (const match of text.matchAll(pathOpenerPattern)) {
    const start = match.index
    if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) continue

    let cursor = start + match[0].length
    let end = cursor
    let components = 0
    while (cursor < text.length) {
      const firstEnd = compactComponentEnd(cursor)
      if (firstEnd === cursor) break
      let componentEnd = firstEnd
      const separator = text[firstEnd]
      if ((separator === ' ' || separator === '\t') && !/[ \t]/.test(text[firstEnd + 1] ?? '')) {
        const secondEnd = compactComponentEnd(firstEnd + 1)
        if (secondEnd > firstEnd + 1 && text[secondEnd] === '\\' && compactPathCharacter(text[secondEnd + 1])) {
          componentEnd = secondEnd
        }
      }

      components += 1
      end = componentEnd
      if (text[componentEnd] !== '\\' || !compactPathCharacter(text[componentEnd + 1])) break
      cursor = componentEnd + 1
      end = cursor
    }
    if (components > 0) ranges.push({ start, end })
  }
  return ranges
}

function firstMatchOutsideWindowsPath(text, pattern) {
  const pathRanges = windowsPathRanges(text)
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (!pathRanges.some((range) => index >= range.start && index < range.end)) return match
  }
  return null
}

function firstProseMatch(segments, pattern) {
  for (const segment of segments) {
    if (segment.kind !== 'prose' && !(segment.kind === 'math' && !segment.closed)) continue
    const match = firstMatchOutsideWindowsPath(segment.raw, pattern)
    if (match) return match
  }
  return null
}

function firstKnownTexCommand(segments) {
  for (const segment of segments) {
    if (segment.kind !== 'prose' && !(segment.kind === 'math' && !segment.closed)) continue
    const pathRanges = windowsPathRanges(segment.raw)
    for (const match of segment.raw.matchAll(/\\([A-Za-z]+)/g)) {
      if (!KNOWN_TEX_COMMANDS.has(match[1])) continue
      if (!pathRanges.some((range) => match.index >= range.start && match.index < range.end)) return match
    }
  }
  return null
}

function cjkTextInsideDelimitedMath(text) {
  return tokenizeMarkdownMath(text).find(({ kind, content }) => (
    kind === 'math' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(content)
  ))
}

export function assertAgentMessageText(text, toolName = 'message_send') {
  const segments = tokenizeMarkdownMath(text)
  const rawTexCommand = firstKnownTexCommand(segments)
  if (rawTexCommand) {
    throw new Error(
      `${toolName}: TeX command ${rawTexCommand[0]} 位于 LaTeX 分隔符外；` +
      `请把完整数学表达式放进 \\(...\\) 或 \\[...\\]，字面命令示例则放进 Markdown code。`
    )
  }
  const literalEscape = firstProseMatch(segments, /\\[nrt](?![a-z])|(?<=[A-Za-z0-9])\\[nrt]/g)
  if (literalEscape) {
    throw new Error(
      `${toolName}: 正文含字面 ${literalEscape[0]}，请改用真实换行或空白；` +
      `需要展示转义写法时，把它放进 Markdown 行内代码或代码块。`
    )
  }
  const decodedTexCorruption = decodedTexCorruptionOutsideMarkdownCode(text)
  if (decodedTexCorruption) {
    throw new Error(
      `${toolName}: 检测到已被工具参数转义破坏的 TeX 片段 ${JSON.stringify(decodedTexCorruption[0])}；` +
      `请用 JSON-safe 的反斜杠重新发送完整 \\(...\\) 或 \\[...\\] 公式，不要猜测补写可见正文。`
    )
  }
  if (cjkTextInsideDelimitedMath(text)) {
    throw new Error(
      `${toolName}: LaTeX 公式内含会触发 KaTeX strict warning 的 CJK 正文；` +
      `请把中文说明移到公式分隔符外，分隔符内只保留数学表达式。`
    )
  }
}

/**
 * 防刷屏(gugu-dev#181):同一个 agent 在同一个群(话题)里,从最后一条人说的话之后数自己发了几条;超过任一条线就在
 * 回执后面提醒一句,不拦。阈值按历史数据定:过去的发送一次都碰不到这三条线。
 */
const FLOOD_LIMITS = [
  { ms: 60_000, max: 8, label: '1 分钟' },
  { ms: 5 * 60_000, max: 12, label: '5 分钟' },
  { ms: 60 * 60_000, max: 30, label: '1 小时' },
]

async function floodNotice(deps, chatId, kind) {
  try {
    const now = Date.now()
    const since = new Date(now - FLOOD_LIMITS.at(-1).ms).toISOString()
    const rows = await deps.restGet(
      `messages?chat_id=eq.${enc(chatId)}&created_at=gte.${enc(since)}&deleted_at=is.null&select=sender_user_id,created_at&order=seq.desc&limit=200`,
    )
    const senders = [...new Set(rows.map((r) => r.sender_user_id).filter((id) => id && id !== deps.context.agentId))]
    const users = await restGetInBatches(senders, (batch) =>
      deps.restGet(`users?id=in.(${batch.map(enc).join(',')})&select=id,type`, 'identity'))
    const humans = new Set(users.filter((u) => u.type === 'human').map((u) => u.id))
    // 人一说话就从头算:只数最后一条人说的话之后的。
    const mine = []
    for (const r of rows) {
      if (humans.has(r.sender_user_id)) break
      if (r.sender_user_id === deps.context.agentId) mine.push(Date.parse(r.created_at))
    }
    const over = FLOOD_LIMITS.map((limit) => ({ ...limit, count: mine.filter((t) => now - t <= limit.ms).length }))
      .find((limit) => limit.count > limit.max)
    if (!over) return ''
    const place = kind === 'topic' ? '话题' : '群'
    return `\n提醒:你在这个${place}里 ${over.label}内已发 ${over.count} 条,其间没有人发言。不急的话先停一下,等有人说话或 @ 你再继续。`
  } catch (err) {
    // 消息已经发出去了:读不到频率只如实说一句,❌ 让这次发送报错(模型会以为没发出去而重发)。
    return `\n这条已发出;发送频率没读到(${err instanceof Error ? err.message : String(err)}),不用重发。`
  }
}

async function handleMessage(args, deps) {
  const requestedAction = args.action
  const writerToolName = requestedAction === 'contact-friend'
      ? 'contact_friend'
      : requestedAction === 'topic-invite'
        ? 'topic_invite'
        : 'message_send'
  if (requestedAction === 'send' || requestedAction === 'contact-friend' || requestedAction === 'topic-invite') {
    assertAgentMessageText(args.text, writerToolName)
  }
  let socialGroup = null
  // 会话绑定的 thread 只属于**本会话那条线**。往别的 chat 里发(contact_friend 的社交小群、
  // topic_invite 的话题)时照搬它,消息会落进目标线里一个不存在的 thread —— 主时间线上看不见。
  let detachThread = false
  if (requestedAction === 'topic-invite') {
    if (!String(args.text ?? '').trim()) {
      throw new Error('topic_invite: text 必填 —— 把人叫进来的那条消息要说清为什么拉他进来,❌ 不要发空消息')
    }
    const topicId = await requireChat(args, deps)
    const topicKind = await chatKindOf(deps, topicId)
    if (topicKind !== 'topic') {
      throw new Error(
        `topic_invite: chat_id ${topicId} 不是一条话题(kind=${topicKind ?? 'unknown'})。` +
        '「点名即入列」只在话题里成立;普通群邀请用 message_invite。用 topic_list 找到话题的 chat_id 再试。'
      )
    }
    const invitees = normToList(args.to_user_ids)
    if (!invitees?.length) {
      throw new Error('topic_invite: to_user_ids 至少要有一个人 —— 没点名的消息谁也拉不进来')
    }
    detachThread = true
    args = { action: 'send', chat_id: topicId, text: args.text, to_user_ids: invitees }
  }
  if (requestedAction === 'contact-friend') {
    const friendUserId = friendUserIdArg(args.friend_user_id)
    const result = await deps.restRpc('request_agent_friend_contact', {
      p_agent_user_id: deps.context.agentId,
      p_friend_user_id: friendUserId,
      p_message: args.text,
    })
    const row = Array.isArray(result) ? result[0] : result
    if (!row || typeof row.chat_id !== 'string' || !row.chat_id.trim()) {
      throw new Error('contact_friend: request_agent_friend_contact returned no chat_id')
    }
    if (row.status === 'pending' || row.status === 'rejected') return JSON.stringify({ ...row, message_id: null })
    if (row.status !== 'already_member') throw new Error('contact_friend: unexpected invitation status')
    socialGroup = {
      chat_id: row.chat_id,
      name: row.name ?? null,
      created: Boolean(row.created),
    }
    detachThread = true
    args = {
      action: 'send',
      chat_id: socialGroup.chat_id,
      text: args.text,
      to_user_ids: [friendUserId],
    }
  }
  const requestedRecipients = await resolveRecipientAddresses(normToList(args.to_user_ids), deps)
  const chatId = await requireChat(args, deps)
  if (args.action === 'send') {
    // @@@1244 — thread 归属由会话绑定决定，模型不可覆盖（防 thread 串话）。
    // 入站已按 acpSessionKey(agent,conv,threadRoot) 隔离到每 thread 一个 session；若出站让模型自由填
    // thread_root_id，它会从上下文读到别的 thread 根 id 填错 → 回复落错 thread。schema 不收 message_send
    // 的 thread_root_id(写类不认识的键直接拒,见 createGuguImServer);这里只用会话绑定的 thread。
    const sessionThread = detachThread ? null : deps.context.threadRootId ?? null
    // #6835 悄悄话 = 标志位 + 只点一个人的 to_user_ids。合不合法(正好一人、不是自己、本 chat 成员)
    // 由库的写入口判一次(chat.enforce_whisper_rule),报错原样交给模型。这里只说库说不清的那一句:
    // 会话绑在 thread 上 —— 悄悄话不进 thread,而 thread 归属是会话定的,模型改不了。
    // 回复就是带上 reply_to_message_id 的一次发送:消息挂在那条原消息下,下面三处寻址规则按它分叉。
    const replyToMessageId = String(args.reply_to_message_id ?? '').trim() || null
    const isReply = replyToMessageId !== null
    // @@@2083 稳定幂等键 + 单一 row 对象:insert 与「发送失败落盘」复用同一 row(零 drift),补投靠稳定
    // client_message_id 走 messages_client_dedup 去重。content 初始 = 原文,群聊 @ 一致性校验后回填修补文本。
    const row = buildMessageRow(deps.context, { id: randomUUID(), chatId, content: args.text, contentType: 'text', toUserIds: requestedRecipients, replyToMessageId, threadRootId: sessionThread })
    // @@@2083 一次完整发送尝试(读+校验+插入)。抽成闭包以便 token 刷新后原样重放一次。
    let sentKind = null
    const attemptSend = async () => {
      // 发送边界只负责校验并写入消息。收件箱由读者在工具边界统一注入，发送工具不重复读取或消费它。
      const [kind, memberRows, source] = await Promise.all([
        chatKindOf(deps, chatId),
        memberRowsOfMyChat(chatId, deps),
        isReply ? replySourceOf(deps, chatId, replyToMessageId, sessionThread) : null,
        // @@@3643 未读群规即拒(兜底闸,见 assertGroupRulesSeen)。
        assertGroupRulesSeen(deps, chatId, 'message_send'),
      ])
      const delivery = resolveReplyDelivery({ senderUserId: deps.context.agentId, source, toUserIds: requestedRecipients, whisper: args.whisper })
      if (!delivery) throw new Error('message_send: cannot resolve the participants of this whisper reply')
      const { toUserIds, isWhisper } = delivery
      if (isWhisper && sessionThread) {
        throw new Error(`message_send: 悄悄话只能发在主线,本会话绑在 thread=${sessionThread} 上,这里发不了;要在这里说就显式设 whisper:false,照常发`)
      }
      row.to_user_ids = toUserIds.length ? toUserIds : null
      if (isWhisper) row.is_whisper = true
      else delete row.is_whisper
      // #84 名单里没有本 agent 的私聊(list_member_ids 在主人是成员时也给名单):是主人与好友的私聊就指去代发,
      // 那里只读不写。复用上面这次名单,agent 在的线零额外读取;放在这一次尝试里,鉴权失效随整条发送换令牌重放。
      if (kind === 'dm' && !memberRows.some((row) => String(row.user_id) === deps.context.agentId)) {
        const friendId = await ownerFriendAmong(deps, new Set(memberRows.map((row) => String(row.user_id))))
        if (friendId) throw ownerFriendDmWriteError(chatId, friendId, 'message_send', 'message_send_as_owner')
      }
      // #849 非成员收件人 fail-loud(复用上面同一次成员查询;话题另收来源线成员,见 addressableUserIds)
      // addressableUserIds 回 null = 它算不出可点名集合(来源线名单读不到)⇒ 这一关跳过,交给服务端判。
      const addressable = await addressableUserIds(deps, chatId, kind, memberRows)
      const invalid = addressable ? recipientsNotInMembers([...addressable], toUserIds) : []
      if (invalid.length) {
        throw new Error(
          `收件人不在本 chat（${chatId}）成员里：${invalid.join(', ')}。用 message_members 查有效成员后重发。`
        )
      }
      if ((kind === 'dm' || kind === 'ai') && isReply && !toUserIds?.length) {
        const memberIds = [...new Set(memberRows.map((row) => String(row.user_id)))]
        const peerIds = memberIds.filter((userId) => userId !== deps.context.agentId)
        if (!memberIds.includes(deps.context.agentId) || memberIds.length !== 2 || peerIds.length !== 1) {
          throw new Error('message_send: a reply in an exact DM without to_user_ids requires the current agent and one unique peer')
        }
        if (source.sender_user_id !== peerIds[0]) {
          throw new Error('message_send: reply_to_message_id in an exact DM must belong to this chat and its unique peer')
        }
      }
      if (kind === 'group' && isReply && !toUserIds?.length) {
        throw new Error('message_send: a reply in a group chat requires explicit to_user_ids')
      }
      // 寻址表达一致性（spec「寻址的表达」）：群聊里校验并修补正文 @ 与 to_user_ids。DM 的寻址隐含
      // （对端唯一），不适用；widget 是 HTML 不适用。零寻址的 group send 还须加载 agent 名册，阻止正文
      // 裸名形成“看得见但没唤醒”的静默断链；reply 或已寻址消息不让系统替作者重判意图。
      let sendText = args.text
      const addressesNobody = !toUserIds?.length && !isReply
      // @@@5856 话题与群同样是「场所」,这道闸在话题里**更**重要:群里 @ 失败只是不响,
      // 话题里 @ 失败是那个人**根本没进来**(join_topic_participants 只认 to_user_ids)。
      const isGroupOrTopic = kind === 'group' || kind === 'topic'
      if (isGroupOrTopic && (addressesNobody || toUserIds?.length || String(args.text ?? '').includes('@'))) {
        const peerIds = memberRows.map((r) => r.user_id).filter((uid) => uid !== deps.context.agentId)
        const users = await restGetInBatches(peerIds, (batch) =>
          deps.restGet(`users?id=in.(${batch.map(enc).join(',')})&select=id,display_name,type`, 'identity'))
        const rec = reconcileMentionExpression(users, args.text, toUserIds, source ? [source.sender_user_id] : [])
        if (rec.mismatches.length) {
          throw new Error(
            `正文 @ 了 ${rec.mismatches.join('、')}，但 to_user_ids 没有他们——话里说的和消息做的必须一致。` +
            `确实要叫他们就把对应 user_id 加进 to_user_ids 重发；不是在叫人就去掉 @（纯文本名字不构成提及）。`
          )
        }
        if (addressesNobody) {
          const bareNameHits = findRosterNameHits(users, args.text)
          if (bareNameHits.length) {
            throw new Error(
              `这条消息没有寻址任何人（to_user_ids 为空、也没有 reply_to_message_id），但正文叫了 ${bareNameHits.map((hit) => hit.name).join('、')}。` +
              `agent 的无寻址发言不会唤醒对方；确实要叫他们就把 user_id 加进 to_user_ids（${bareNameHits.flatMap((hit) => hit.ids).join('、')}）重发，` +
              `只是提到则改写成不指名的说法。`
            )
          }
        }
        sendText = rec.content
      }
      row.content = String(sendText ?? '')
      await postCommandMessageRow(deps, row)
      sentKind = kind
    }
    const okMsg = () => socialGroup
      ? JSON.stringify({ ...socialGroup, message_id: row.id })
      : requestedAction === 'topic-invite'
        ? `invited into the topic (id=${row.id}); 被点名的人当场成为参与者,继续说话用 message_send 带这条话题的 chat_id`
        : (isReply ? `replied (id=${row.id})` : `sent (id=${row.id})`)
    // 群和话题里发得太密:回执后面提醒一句,不拦(gugu-dev#181 防刷屏)。contact_friend 的回执是 JSON,不往后接字。
    const receipt = async () => okMsg() + await archivedDeliveryReceipt(deps, row.id)
      + (!socialGroup && (sentKind === 'group' || sentKind === 'topic') ? await floodNotice(deps, chatId, sentKind) : '')
    try {
      await attemptSend()
      return await receipt()
    } catch (err) {
      // 业务校验错原样抛给模型。鉴权失效只允许读取 host 新 token 后原样重试一次；command lease
      // 不能进入 outbox，延后直插也不能越过数据库 fence。
      if (!isRefreshableAuthError(err)) throw err
      // @@@2083 切片2(option B)— 先从 host 每 tick resync 的 session 文件拉更新的 token,拿到就整条重发一次
      // (Desktop 开着时 token 已被刷新 → 秒级恢复)。renderer/main 唯一刷新,子进程只读。
      const fresh = await deps.context.getAccessToken()
      if (fresh && fresh !== err.accessToken) {
        try {
          await attemptSend()
          return await receipt()
        } catch (err2) {
          if (!isRefreshableAuthError(err2)) throw err2
          // 新鲜 token 仍投不出时由当前 turn fail loud。
        }
      }
      throw err
    }
  }
  // 读历史 / 搜索按 **agent 自己**的可见域:MCP 拿的是主人的 JWT,直读 messages_view 判的是主人的
  // 入群时间界 ⇒ 群开了「隐藏聊天记录」,后进群的 agent 照样读到入群前的消息。
  // chat.message_history_as / message_search_as 是 SECURITY DEFINER,按 p_as_user_id 判(与 chat_facts 同一做法),
  // 悄悄话、成员时间界、话题继承来源线的时间界都在库里判,❌ 不在这里再拼一层过滤。
  // 唯一的例外是主人与好友的私聊(#84):agent 不在里面,按主人本人读(见 ownerFriendDms)。
  const readAs = args.action === 'history' || args.action === 'search'
    ? (await ownerFriendOfDm(deps, chatId) ? await currentAuthUserId(deps) : deps.context.agentId)
    : null
  if (args.action === 'history') {
    const rows = await messageHistoryPage(deps, chatId, { asUserId: readAs,
      threadRootId: args.thread_root_id ? String(args.thread_root_id) : null,
      beforeSeq: Number.isFinite(args.before_seq) ? Math.floor(args.before_seq) : null,
      limit: clampLimit(args.limit, 20, 1, 100) })
    return JSON.stringify((rows ?? []).map(withFolderFile))
  }
  if (args.action === 'search') {
    const rows = await deps.restRpc('message_search_as', {
      p_chat_id: chatId,
      p_query: String(args.query ?? ''),
      p_as_user_id: readAs,
      p_before_seq: Number.isFinite(args.before_seq) ? Math.floor(args.before_seq) : null,
      p_limit: clampLimit(args.limit, 20, 1, 100),
    })
    return JSON.stringify((rows ?? []).map(withFolderFile))
  }
  throw new Error(`gugu_message: unknown action ${args.action}`)
}

// agent 自己所在的会话,连同它在每个会话里的 role / listen_mode(chat.list_my_chats_as,按它自己的成员行判)。
// ❌ 用主人令牌直读 chat_members / chats:读 RLS 按主人判,主人退了群、agent 还在,这个群就从它自己的列表里消失了。
async function myChats(deps) {
  return (await deps.restRpc('list_my_chats_as', { p_as_user_id: deps.context.agentId })) ?? []
}

/**
 * 主人的好友 id。好友关系的唯一真值是 identity.friendships（无 status 列，行存在即已接受；#1985 收敛后 chat.contacts
 * 是死表），只有两位当事人读得到 ⇒ 主人的令牌直读就是主人的好友表。owner_friends_list 与主人私聊(#84)同一读法。
 */
async function ownerFriendIds(deps, ownerUserId) {
  const friendships = await deps.restGet(
    `friendships?or=(user_a_id.eq.${enc(ownerUserId)},user_b_id.eq.${enc(ownerUserId)})&select=user_a_id,user_b_id`,
    'identity',
  )
  const ids = new Set()
  for (const row of friendships) {
    const friendId = row.user_a_id === ownerUserId
      ? row.user_b_id
      : row.user_b_id === ownerUserId
        ? row.user_a_id
        : null
    if (typeof friendId !== 'string' || !friendId) {
      throw new Error('owner_friends_list: friendship row does not contain the authenticated owner')
    }
    ids.add(friendId)
  }
  return ids
}

/** 主人给联系人起的备注(主人平时说「看看老王说了啥」用的就是它)。 */
async function ownerAliases(deps, ownerUserId) {
  const rows = await deps.restGet(`contact_overrides?owner_user_id=eq.${enc(ownerUserId)}&select=contact_user_id,alias`, 'identity')
  return new Map(rows.map((row) => [row.contact_user_id, row.alias]))
}

/** 两人私聊、主人在、本 agent 不在、另一位是主人的好友 ⇒ 那位好友的 id;否则 null。 */
function friendOfOwnerDm(memberIds, ownerUserId, agentId, friendIds) {
  if (memberIds.size !== 2 || !memberIds.has(ownerUserId) || memberIds.has(agentId)) return null
  const [peer] = [...memberIds].filter((id) => id !== ownerUserId)
  return friendIds.has(peer) ? peer : null
}

/**
 * @@@84 主人与好友的私聊。agent 不是成员(代发也不让它进去,#7299),主人要它看时按**主人**的可见域读:同一组
 * chat.*_as 传主人本人(is_acting_as 放行本人),悄悄话、成员时间界仍在库里判,❌ 不在这里另拼过滤。
 * 范围 = 「主人 + 一位当前人类好友」的两人私聊,与代发同一口径;主人和自己 agent 的、和非好友 / 已删好友的都不算。
 * 何时读由主人说了算:工具说明写「只在主人要求时」,与代发同口径(按回合的程序闸另议,#5661 Q5)。
 * 写不并进来:message_send 遇到这些会话指去 message_send_as_owner(assertNotOwnerFriendDm)。
 */
async function ownerFriendDms(deps) {
  const ownerUserId = await currentAuthUserId(deps)
  const [chats, friendIds] = await Promise.all([
    deps.restRpc('list_my_chats_as', { p_as_user_id: ownerUserId }),
    ownerFriendIds(deps, ownerUserId),
  ])
  const dms = (Array.isArray(chats) ? chats : []).filter((chat) => chat.kind === 'dm')
  if (!dms.length || !friendIds.size) return []
  const memberRows = await restGetInBatches(dms.map((chat) => chat.chat_id), (batch) =>
    deps.restGet(`chat_members?chat_id=in.(${batch.map(enc).join(',')})&select=chat_id,user_id`))
  const membersByChat = new Map()
  for (const row of memberRows) {
    if (!membersByChat.has(row.chat_id)) membersByChat.set(row.chat_id, new Set())
    membersByChat.get(row.chat_id).add(String(row.user_id))
  }
  const friendByChat = new Map()
  for (const [chatId, memberIds] of membersByChat) {
    const friendId = friendOfOwnerDm(memberIds, ownerUserId, deps.context.agentId, friendIds)
    if (friendId) friendByChat.set(chatId, friendId)
  }
  if (!friendByChat.size) return []
  const [users, aliasById] = await Promise.all([
    restGetInBatches([...new Set(friendByChat.values())], (batch) => deps.restGet(
      `users?id=in.(${batch.map(enc).join(',')})&select=id,display_name,type`,
      'identity',
    )),
    ownerAliases(deps, ownerUserId),
  ])
  const humans = new Map(users.filter((user) => user.type === 'human').map((user) => [user.id, user]))
  return dms.flatMap((chat) => {
    const friend = humans.get(friendByChat.get(chat.chat_id))
    if (!friend) return []
    return [{ ...chat, friend_user_id: friend.id, friend_display_name: friend.display_name ?? null, owner_remark: aliasById.get(friend.id) ?? null }]
  })
}

/**
 * 这条会话是不是主人与好友的私聊(见 ownerFriendDms):是就回那位好友的 id,否则 null。
 * 不是私聊的零额外读取(kind 本就记忆化);本 agent 自己在里面的私聊也不是。
 */
async function ownerFriendOfDm(deps, chatId) {
  if (await chatKindOf(deps, chatId) !== 'dm') return null
  // 私聊的两位成员建好就定了:本 agent 在里面的私聊记一次,这个会话里不再为它多读名单。
  // ❌ 记「是主人的好友私聊」—— 好友会被删,那一半每次现判。
  if (!deps.state.agentDms) deps.state.agentDms = new Set()
  if (deps.state.agentDms.has(chatId)) return null
  // 名单按 agent 判(list_member_ids:agent 在或主人在都给);❌ 主人令牌直读 chat_members —— agent 和别人的私聊
  // 主人不在,读回空,这里就记不住,每次都白读一遍名单和好友表。两人都不在 ⇒ 空 ⇒ 不是。
  const rows = await deps.restRpc('list_member_ids', { p_chat_id: chatId, p_as_user_id: deps.context.agentId })
  const memberIds = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.user_id)))
  if (memberIds.has(deps.context.agentId)) {
    deps.state.agentDms.add(chatId)
    return null
  }
  return ownerFriendAmong(deps, memberIds)
}

/** 一条私聊的成员里:主人在、本 agent 不在、另一位是主人当前的人类好友 ⇒ 那位好友的 id;否则 null。 */
async function ownerFriendAmong(deps, memberIds) {
  if (memberIds.has(deps.context.agentId)) return null
  const ownerUserId = await currentAuthUserId(deps)
  const friendId = friendOfOwnerDm(memberIds, ownerUserId, deps.context.agentId, await ownerFriendIds(deps, ownerUserId))
  if (!friendId) return null
  const users = await deps.restGet(`users?id=eq.${enc(friendId)}&select=type`, 'identity')
  return users[0]?.type === 'human' ? friendId : null
}

/** 主人的好友私聊只读不写:以主人名义说话是对外的动作,只走代发工具(好友看得到「AI 发送」)。 */
function ownerFriendDmWriteError(chatId, friendId, toolName, ownerToolName) {
  return new Error(
    `${toolName}: chat ${chatId} is your owner's DM with a friend, and you are not in it. ` +
    `To write there as your owner (only when your owner asks), use ${ownerToolName} with friend_user_id ${encodeTypedId('user', friendId)}.`,
  )
}
async function assertNotOwnerFriendDm(deps, chatId, toolName, ownerToolName) {
  const friendId = await ownerFriendOfDm(deps, chatId)
  if (friendId) throw ownerFriendDmWriteError(chatId, friendId, toolName, ownerToolName)
}

/**
 * 主人在自己的聊天列表里置顶了哪些会话。真相源只有一处:`chat.chat_members.is_pinned` 主人那一行(界面的
 * setChatPinned 写的就是它;联系人置顶 = 和他那条私聊置顶)。agent 自己那一行的 is_pinned 没人会去点。
 */
async function ownerPinnedChatIds(deps) {
  const ownerUserId = await currentAuthUserId(deps)
  const rows = await deps.restGet(`chat_members?user_id=eq.${enc(ownerUserId)}&is_pinned=is.true&select=chat_id`)
  return new Set((Array.isArray(rows) ? rows : []).map((row) => row.chat_id))
}

/**
 * agent 行的运行状态(core agentStatus 词表),两种来源写在行上:
 *   · `this_machine` —— 跑在这台机器上的 agent:宿主按 agent 的状态流(会话页状态写入者的输出)现读;
 *   · `cloud` —— 其余:presence 行,是跑它的那台宿主发布的副本,带发布时刻(`status_at`)与那台机器在不在线
 *     (`host_online`,即设备行的在线状态),宿主离线或没发布时会旧 ⇒ 当作「最后一次听说」,❌ 当作确凿事实。
 * 看不到的 agent(presence 不对你开放)不给状态。
 *
 * 状态是名录的附加信息:哪一路读不到,❌ 让整张名录失败(寻址「按名字找 id」就靠它),也 ❌ 悄悄当没有 ——
 * 读不到的原因原样放进 `unavailable`,由调用方写在返回里。
 */
async function agentStatusReadings(deps, agentUserIds) {
  const readings = new Map()
  const problems = []
  if (!agentUserIds.length) return { readings, unavailable: null }
  if (deps.context.runHostAction) {
    try {
      const local = await deps.context.runHostAction({ action: 'agent-status', agentUserIds })
      if (!Array.isArray(local)) throw new Error('host returned a non-list result')
      for (const row of local) {
        readings.set(row.agentUserId, { status: row.status ?? null, detail: row.detail ?? null, status_from: 'this_machine' })
      }
    } catch (err) {
      problems.push(`this machine: ${err?.message ?? err}`)
    }
  }
  const remote = agentUserIds.filter((id) => !readings.has(id))
  // 服务端一次最多 200 个 id(超了响亮地拒);分批问,❌ 截断。
  for (let i = 0; i < remote.length; i += 200) {
    try {
      const batch = await deps.restRpc('get_agent_presence_batch', { p_agent_user_ids: remote.slice(i, i + 200) }, 'identity')
      const results = batch?.results ?? {}
      for (const id of remote.slice(i, i + 200)) {
        const presence = results[id]?.status === 'presence' ? results[id].presence : null
        if (!presence) continue
        readings.set(id, {
          status: presence.session_archived_at ? 'archived' : presence.agent_status ?? null,
          detail: presence.session_archived_at ? null : presence.agent_status_detail ?? null,
          status_from: 'cloud',
          status_at: presence.updated_at ?? null,
          // 那台机器在不在线只看设备行(#5912:租约清扫者翻它,在线 / 离线的唯一来源)。
          host_online: presence.device_status === 'online' ? true : presence.device_status === 'offline' ? false : null,
        })
      }
    } catch (err) {
      problems.push(`cloud presence: ${err?.message ?? err}`)
    }
  }
  if (problems.length) log.warn({ problems }, 'member status lookup incomplete')
  return { readings, unavailable: problems.length ? problems.join('; ') : null }
}

async function handleConv(args, deps) {
  if (args.action === 'members') {
    const chatId = await requireChat(args, deps)
    // 这条**不**走 memberRowsOfMyChat:message_members 可以问一条我不在的线,零行是合法答案。
    const rows = (await deps.restRpc('list_member_ids', { p_chat_id: chatId, p_as_user_id: deps.context.agentId })) ?? []
    // 名录必须带名字:寻址是「按可读名找 ID 再发」(人说「让 Codex 8 去干」→ agent 查名录得 id →
    // to_user_ids)。只回 user_id 的名单无法完成这一步,等于逼模型猜 id。display_name + 咕咕号从
    // identity 富化(与 history/@ 校验同一路数),空名单零额外查询。
    if (!rows.length) return { items: rows }
    const users = await restGetInBatches(rows.map((r) => r.user_id), (batch) => deps.restGet(
      `users?id=in.(${batch.map(enc).join(',')})&select=id,display_name,type,gugu_number`,
      'identity',
    ))
    const byId = new Map(users.map((u) => [u.id, u]))
    const members = rows.map((r) => {
      const u = byId.get(r.user_id)
      return {
        ...r,
        display_name: u?.display_name ?? null,
        type: u?.type ?? null,
        gugu_number: u?.gugu_number ?? null,
        is_self: r.user_id === deps.context.agentId,
      }
    })
    const status = await agentStatusReadings(deps, members.filter((m) => m.type === 'agent').map((m) => m.user_id))
    // 成员没有活动时间可排:按名字排,翻页才有确定的顺序。
    const items = members
      .map((m) => (m.type === 'agent' ? { ...m, ...status.readings.get(m.user_id) } : m))
      .sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''))
        || String(a.user_id).localeCompare(String(b.user_id)))
    return status.unavailable ? { items, status_unavailable: status.unavailable } : { items }
  }
  if (args.action === 'list') {
    const [chats, ownerDms, pinned] = await Promise.all([myChats(deps), ownerFriendDms(deps), ownerPinnedChatIds(deps)])
    const rows = [
      ...chats.map((c) => ({
        id: c.chat_id,
        public_id: c.public_id,
        kind: c.kind,
        status: c.status,
        name: c.name,
        pinned: pinned.has(c.chat_id),
        last_message_at: c.last_message_at,
        last_message_preview: c.last_message_preview,
      })),
      // #84 主人与好友的私聊:名字用主人的备注,没有就用好友自己的名字;friend_user_id 直接喂代发工具。
      ...ownerDms.map((c) => ({
        id: c.chat_id,
        public_id: c.public_id,
        kind: c.kind,
        status: c.status,
        name: c.owner_remark || c.friend_display_name,
        owner_dm: true,
        friend_user_id: c.friend_user_id,
        friend_display_name: c.friend_display_name,
        pinned: pinned.has(c.chat_id),
        last_message_at: c.last_message_at,
        last_message_preview: c.last_message_preview,
      })),
    ]
    // 两份各自已按最近消息排好,并成一张再按同一键排一次;稳定排序,同一时刻(含都没有消息)保持原序。
    const recency = (row) => (row.last_message_at ? Date.parse(row.last_message_at) || 0 : 0)
    return rows.sort((a, b) => recency(b) - recency(a))
  }
  if (args.action === 'rules') {
    const chatId = await requireChat(args, deps)
    const rows = await deps.restGet(
      `chats?id=eq.${enc(chatId)}&select=id,public_id,name,kind,status,group_prompt,default_agent_type,join_mode,hide_history`
    )
    // @@@3643 主动读也记已读:读过这一版就不该再被 send 闸拦。记的是原文,与发送时取到的当前版逐字比对。
    // #3641 话题没立规矩时沿用来源群的 —— 回给 agent 的也是那份生效的规矩,并注明出处。
    const raw = rows[0]?.group_prompt
    const own = typeof raw === 'string' && raw.trim() ? raw : ''
    const effective = rows[0]?.kind === 'topic' && !own ? await currentGroupRules(deps, chatId) : own
    deps.state.readGroupRules.set(chatId, effective)
    const chat = rows[0]
      ? { ...rows[0], ...(effective !== own ? { group_prompt: effective, group_prompt_from: 'source_chat' } : {}) }
      : null
    if (chat?.kind === 'group' && !deps.state.joinContextShown.has(chatId)) {
      // This RPC is the join gate's fact source. The in-memory bit prevents repeated rules calls
      // in one MCP session from repeating a one-time prompt; it never guesses from message times.
      const joinRows = await deps.restRpc(
        'get_agent_join_context',
        { p_agent_user_id: deps.context.agentId, p_chat_id: chatId },
        'identity',
      )
      deps.state.joinContextShown.add(chatId)
      const joinContext = parseJoinContext(joinRows, chatId)
      if (joinContext) return JSON.stringify({ ...chat, join_context: joinContext })
    }
    return JSON.stringify(chat)
  }
  if (args.action === 'lookup') {
    // 咕咕号用来**找人**，UUID 用来记事：人报一个号，这里把它解析成 canonical identity（人或公开 agent 都有号；
    // 未公开的 agent 没有号，也就找不到）。可见性与人在「添加好友」搜索里看到的一致——同一个 SECURITY DEFINER
    // RPC（identity.search_users），❌ 不另开一条更宽的查人路径。返回的 id 就是别的动作要的 user: id；
    // 能不能发消息仍由会话成员关系 / 本机 session 路由决定，这里只回答「这个号是谁、是不是 owner 的联系人」。
    const raw = args.gugu_number
    const hit = typeof raw === 'string' && raw.trim().startsWith('user:')
      ? await lookupUserId(userIdArg(raw), deps)
      : await lookupGuguNumber(guguNumberArg(raw), deps)
    // 好友关系的唯一真值是 identity.friendships（无 status 列，行存在即已接受；#1985 收敛后 chat.contacts 是死表）。
    // owner token + fs_select RLS 只回当事人两行，两向匹配即「是 owner 的好友」。❌ 吞错：查失败要响亮报错。
    const friendships = await deps.restGet(
      `friendships?or=(user_a_id.eq.${enc(hit.id)},user_b_id.eq.${enc(hit.id)})&select=user_a_id,user_b_id`,
      'identity',
    )
    return JSON.stringify({
      user_id: hit.id,
      display_name: hit.display_name ?? null,
      type: hit.type ?? null,
      gugu_number: hit.gugu_number ?? null,
      agent_public: hit.agent_public ?? null,
      is_owner_contact: Array.isArray(friendships) && friendships.length > 0,
    })
  }
  throw new Error(`gugu_conv: unknown action ${args.action}`)
}

// ── topic_ ── 话题:从一条已有消息长出来的独立工作线(product spec)。
// 话题的开、列、删走独立命令；收发消息、看历史、查成员都走
// 既有的 message_* / topic_members,❌ 不为话题另造一套收发工具(造了就是第二条会漂移的路)。
// 删除由数据库同时核验当前 agent 的来源群管理权和逐字确认名。
async function handleTopic(args, deps) {
  if (args.action === 'open') {
    const sourceChatId = await requireChat(args, deps)
    const sourceMessageId = String(args.source_message_id ?? '').trim()
    if (!sourceMessageId) {
      throw new Error('topic_open: source_message_id is required —— 话题只能从一条已有消息长出来,❌ 不能凭空建')
    }
    const memberUserIds = await resolveRecipientAddresses(normToList(args.to_user_ids), deps, 'to_user_ids')
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null
    // ⚠️ p_as_user_id 必须是**当前 agent**,不是主人。漏传时 create_topic 会 COALESCE 成 auth.uid()
    // (= 主人),于是话题被记成主人开的,来源线里也不会留下那条「X 开了话题」的痕迹 —— 静默的错:
    // 话题照样建出来,只是归属和留痕都错了。spec:「agent 建的话题归属它的主人,但来源线里要显示是它开的」。
    // #84 库里的 create_topic 只要主人在来源线就放行 agent;来源是主人与好友的私聊时,开话题等于把好友拉进来、
    // 再往那条私聊里留一条「X 开了话题」—— 绕过「那里只读不写,以主人名义说话只走代发」。
    await assertNotOwnerFriendDm(deps, sourceChatId, 'topic_open', 'message_send_as_owner')
    const rows = await deps.restRpc('create_topic', {
      p_source_chat_id: sourceChatId,
      p_source_message_id: sourceMessageId,
      p_name: name,
      p_member_user_ids: memberUserIds,
      p_as_user_id: deps.context.agentId,
    })
    const row = Array.isArray(rows) ? rows[0] : rows
    if (!row || typeof row.chat_id !== 'string' || !row.chat_id.trim()) {
      throw new Error('topic_open: create_topic returned no chat_id')
    }
    // 服务端会**悄悄滤掉**不在来源线里的人(话题的取人范围是来源线,这条规则是对的),
    // 但悄悄这件事不对:调用方以为三个人都进去了。❌ 不静默丢掉一个收件人 —— 把真实名单回出去,
    // 并把没进来的人单列一行,agent 一眼看得出该不该改用别的线。
    // ❗这里不抛错:同一次调用里「大部分人进去了」是有价值的结果,抛掉等于连话题也没了。
    // 与 topic_invite 的分工:那个只拉人,全员失败就没有任何意义,所以它 fail-loud。
    const members = await deps.restRpc('list_member_ids',
      { p_chat_id: row.chat_id, p_as_user_id: deps.context.agentId })
    const joined = new Set((Array.isArray(members) ? members : []).map((m) => String(m.user_id)))
    // ⚠️ 一条话题至少有它的创建者,所以「读到 0 行」只可能是**读不到**,不可能是真的没人。
    // 那时 ❌ 不许下「这些人不在来源线里」的结论 —— 那与事实相反。
    // (这条读已经带 p_as_user_id 按 agent 自己判了;仍然留这道闸,因为 RPC 本身也可能读空。)
    if (joined.size === 0) {
      return JSON.stringify({
        ...row,
        member_user_ids_unavailable:
          '话题建好了,但用当前身份读不到它的成员名单(主人不在这条线里)。'
          + '用 topic_members 以这条话题自己的 chat_id 再查一次。',
      })
    }
    // 服务端会**悄悄滤掉**不在来源线里的人。悄悄这件事不对:调用方以为三个人都进去了。
    const dropped = (memberUserIds ?? []).filter((id) => !joined.has(id))
    return JSON.stringify({
      ...row,
      member_user_ids: [...joined],
      ...(dropped.length
        ? {
            not_added_user_ids: dropped,
            not_added_reason:
              '这些人不在来源线里。话题的取人范围就是来源线(在已有范围里收窄),'
              + '❌ 不能借开话题把线外的人拉进来。要找他们,去你们共同所在的那条线上开。',
          }
        : {}),
    })
  }
  if (args.action === 'list') {
    const sourceChatId = await requireChat(args, deps)
    // ⚠️ p_as_user_id 与 open 那一支同理,漏传就是**静默的错**:list_topics_of_chat 判的是 auth.uid()
    // (= 主人),于是 is_participant 回答的是「主人在不在」,而工具描述写的是「whether **you** are in it」。
    // 主人自己开的话题 → agent 读到 true → 不再 @ 自己进去 → 永远收不到这条线的任何消息。
    // 反过来 agent 在主人不在的线上开的话题,不传 actor 时整条线列不出来,它会一条一条重复开。
    const rows = await deps.restRpc('list_topics_of_chat', {
      p_source_chat_id: sourceChatId,
      p_as_user_id: deps.context.agentId,
    })
    return Array.isArray(rows) ? rows : []
  }
  if (args.action === 'delete') {
    if (typeof args.confirm_name !== 'string' || args.confirm_name.length === 0) {
      throw new Error('topic_delete: confirm_name is required and must be the exact current topic name')
    }
    const chatId = await assertIsTopic(args, deps, 'topic_delete')
    const row = await deps.restRpc('archive_topic_as', {
      p_chat_id: chatId,
      p_as_user_id: deps.context.agentId,
      p_confirm_name: args.confirm_name,
    })
    if (row?.chat_id !== chatId || row?.status !== 'archived') {
      throw new Error('topic_delete: database did not confirm topic deletion')
    }
    return JSON.stringify(row)
  }
  throw new Error(`gugu_topic: unknown action ${args.action}`)
}

// ── group_ ── #6492 主人所在的群:列出来、自己进去、把主人名下的其他 agent 拉进去。
// 可见域在库里一处定:chat.list_owner_groups_as 只列主人是成员的群、只给入群要用的元数据(不给预览或正文),
// p_as_user_id 必须是主人名下的 agent。入群走 chat.add_group_agent —— 与人在界面上「把我的 agent 拉进群」
// 同一条路(主人必须在群里,「Agent 加入需审批」照常生效)。❌ 不从这里直读 chats / chat_members。
async function ownerGroupsAs(deps, agentUserId, toolName) {
  let rows
  try {
    rows = await deps.restRpc('list_owner_groups_as', { p_as_user_id: agentUserId })
  } catch (err) {
    if (err instanceof RpcHttpError && /Not allowed to act as/.test(err.detail ?? '')) {
      throw new Error(
        `${toolName}: user:${agentUserId} is not one of your owner's agents. group_add_agent only adds your owner's own agents; `
        + 'to bring a person or someone else\'s agent into a group use message_invite — they have to accept.'
      )
    }
    throw err
  }
  if (!Array.isArray(rows)) throw new Error(`${toolName}: list_owner_groups_as returned a non-list result`)
  return rows
}

function groupAdmin(deps) {
  return createGroupAdmin({ rpc: async (name, body) => ({ data: await deps.restRpc(name, body), error: null }) }, deps.context.agentId)
}

async function handleGroup(args, deps) {
  if (args.action === 'create') {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) throw new Error('group_create: name cannot be empty')
    if (args.members !== undefined && !Array.isArray(args.members)) throw new Error('group_create: members must be an array of typed addresses')
    const ownerId = await currentAuthUserId(deps)
    const resolved = await resolveRecipientAddresses(decodeRecipientList(args.members ?? [], 'members'), deps, 'members')
    const ids = [...new Set([deps.context.agentId, ...resolved])].filter((id) => id !== ownerId)
    if (ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) throw new Error('group_create: members must resolve to canonical identity UUIDs')
    const users = await restGetInBatches(ids, (batch) => deps.restGet(
      `users?id=in.(${batch.map(enc).join(',')})&select=id,type,owner_user_id`, 'identity',
    ))
    if (ids.some((id) => !users.some((row) => row.id === id))) throw new Error('group_create: selected person or agent was not found')
    return JSON.stringify(await createGroupWithInvitations({
      rpc: async (name, body) => ({ data: await deps.restRpc(name, body), error: null }),
    }, name, ownerId, deps.context.agentId, users))
  }
  if (args.action === 'list') {
    const [groups, pinned] = await Promise.all([ownerGroupsAs(deps, deps.context.agentId, 'group_list'), ownerPinnedChatIds(deps)])
    return groups.map((group) => ({ ...group, pinned: pinned.has(group.chat_id) }))
  }
  const admin = groupAdmin(deps)
  if (args.action === 'join-decide') return JSON.stringify(await admin.decideJoin(args.request_id, args.accept))
  if (args.action === 'announcement-update') return JSON.stringify(await admin.updateAnnouncement(args.announcement_id, {
    ...(args.changes.text !== undefined ? { content: args.changes.text } : {}),
    ...(args.changes.pinned !== undefined ? { pinned: args.changes.pinned } : {}),
  }))
  if (args.action === 'announcement-delete') return JSON.stringify(await admin.deleteAnnouncement(args.announcement_id))
  if (args.action === 'flood-undo') return JSON.stringify(await admin.undoFlood(args.adjustment_id))
  const chatId = await requireChat(args, deps)
  if (args.action === 'add-agent') {
    const requested = typeof args.agent === 'string' ? args.agent.trim() : ''
    const [agent] = requested ? await resolveRecipientAddresses(decodeRecipientList([requested], 'agent'), deps, 'agent') : [deps.context.agentId]
    return JSON.stringify({ ...await admin.addAgent(chatId, agent), agent_user_id: agent })
  }
  if (await chatKindOf(deps, chatId) !== 'group') throw new Error(`group_${args.action}: chat_id must identify a group`)
  if (args.action === 'info') return JSON.stringify(await admin.info(chatId))
  if (args.action === 'leave') return JSON.stringify(await admin.remove(chatId, deps.context.agentId))
  if (args.action === 'remove' || args.action === 'role') {
    const [member] = await resolveRecipientAddresses(decodeRecipientList([args.member], 'member'), deps, 'member')
    return JSON.stringify(args.action === 'remove' ? await admin.remove(chatId, member) : await admin.setRole(chatId, member, args.role))
  }
  if (args.action === 'join-requests') return admin.joinRequests(chatId)
  if (args.action === 'update') {
    const changes = { ...args.changes }
    if (changes.rules !== undefined) { changes.group_prompt = changes.rules; delete changes.rules }
    return JSON.stringify(await admin.update(chatId, changes))
  }
  if (args.action === 'announcement-post') return JSON.stringify(await admin.postAnnouncement(chatId, args.text))
  if (args.action === 'avatar') {
    const bytes = await readUploadBytes('group_avatar_set', args, 5 * 1024 * 1024)
    const file = new File([bytes], basename(args.file_path), { type: resolveAttachmentMimeType(args.file_path) })
    const url = await setGroupAvatar(admin, chatId, await currentAuthUserId(deps), file, deps.uploadGroupAvatar)
    return JSON.stringify({ chat_id: chatId, avatar_url: url })
  }
  throw new Error(`gugu_group: unknown action ${args.action}`)
}

/** One invitation path for message_invite and members requested while creating a group. */
async function requestGroupInvitation(chatId, invitee, text, deps) {
  assertAgentMessageText(text, 'message_invite')
  if (!text?.trim()) throw new Error('message_invite: text is required')
  return groupAdmin(deps).invite(chatId, invitee, text)
}

/**
 * 联系人置顶 = 主人和他那条私聊置顶(联系人页的 contactPinned 读的就是它)。没有置顶的会话就零额外查询。
 * 先把置顶的会话筛到私聊,再读这些私聊里主人以外的那个人;每条 URL 只带一张 id 列表,按批读。
 */
async function friendsWithPinnedDm(deps, ownerUserId, friendIds) {
  const pinned = [...await ownerPinnedChatIds(deps)]
  if (!pinned.length) return new Set()
  const dms = await restGetInBatches(pinned, (batch) =>
    deps.restGet(`chats?id=in.(${batch.map(enc).join(',')})&kind=eq.dm&select=id`))
  if (!dms.length) return new Set()
  const peers = await restGetInBatches(dms.map((row) => row.id), (batch) =>
    deps.restGet(`chat_members?chat_id=in.(${batch.map(enc).join(',')})&user_id=neq.${enc(ownerUserId)}&select=chat_id,user_id`))
  const friends = new Set(friendIds)
  return new Set(peers.map((row) => row.user_id).filter((id) => friends.has(id)))
}

async function handleProfile(args, deps) {
  if (args.action === 'owner-friends') {
    const ownerUserId = await currentAuthUserId(deps)
    const friendIdSet = await ownerFriendIds(deps, ownerUserId)
    const friendIds = [...friendIdSet]
    if (!friendIds.length) return []

    const [users, aliasById, pinnedFriends] = await Promise.all([
      restGetInBatches(friendIds, (batch) => deps.restGet(
        `users?id=in.(${batch.map(enc).join(',')})&select=id,display_name,type,gugu_number,avatar,bio`,
        'identity',
      )),
      ownerAliases(deps, ownerUserId),
      friendsWithPinnedDm(deps, ownerUserId, friendIds),
    ])
    const humanFriends = users
      .filter((user) => friendIdSet.has(user.id) && user.type === 'human')
      .map((user) => ({
        user_id: user.id,
        display_name: user.display_name,
        owner_remark: aliasById.get(user.id) ?? null,
        gugu_number: user.gugu_number ?? null,
        avatar: user.avatar ?? null,
        bio: user.bio ?? null,
        pinned: pinnedFriends.has(user.id),
      }))
      .sort((left, right) => String(left.display_name).localeCompare(String(right.display_name))
        || String(left.user_id).localeCompare(String(right.user_id)))
    return humanFriends
  }
  if (args.action === 'whoami') {
    // 自己此刻的状态都在这里现读:名字会变,所以不写进 agent 的上下文;主人是谁;在哪些群里、各是什么角色与监听档。
    const rows = await deps.restGet(`users?id=eq.${enc(deps.context.agentId)}&select=gugu_number,display_name,avatar,bio,owner_user_id`, 'identity')
    const { owner_user_id: ownerId = null, ...profile } = rows[0] ?? {}
    const [owners, chats] = await Promise.all([
      ownerId ? deps.restGet(`users?id=eq.${enc(ownerId)}&select=id,display_name,gugu_number`, 'identity') : [],
      myChats(deps),
    ])
    const owner = owners[0]
    return JSON.stringify({
      user_id: deps.context.agentId,
      ...profile,
      owner: owner ? { user_id: owner.id, display_name: owner.display_name, gugu_number: owner.gugu_number ?? null } : null,
      groups: chats.filter((c) => c.kind === 'group').map((c) => ({
        chat_id: c.chat_id,
        public_id: c.public_id,
        name: c.name,
        status: c.status,
        role: c.role,
        listen_mode: c.listen_mode,
      })),
    })
  }
  if (args.action === 'update') {
    const patch = {}
    if (args.display_name !== undefined) patch.display_name = args.display_name
    if (args.avatar !== undefined) patch.avatar = args.avatar
    if (args.bio !== undefined) patch.bio = args.bio
    if (!Object.keys(patch).length) throw new Error('profile_update: 至少给一个 display_name / avatar / bio')
    await deps.restPatch(`users?id=eq.${enc(deps.context.agentId)}`, patch, 'identity')
    return `profile updated (${Object.keys(patch).join(', ')})`
  }
  throw new Error(`gugu_profile: unknown action ${args.action}`)
}



// gugu_file:send-file = 字节经 attachments/upload 直传 OSS,attachments/commit 放进会话的「附件」、发一条附件消息(#7290 gugu-3,
// 和人发附件同一条路);download = 按消息 id 把附件下到本机(downloadAttachment)。
async function uploadForSend(args, deps, label, chatId) {
  const bytes = await readUploadBytes(label, args, ATTACHMENT_MAX_BYTES)
  const fileName = resolveUploadName(args)
  const contentType = resolveAttachmentMimeType(basename(String(args.file_path)), args.mime_type)
  const endpoint = await deps.attachmentsEndpoint()
  return { endpoint, fileName, contentType, stagingKey: await uploadAttachmentBytes(endpoint, { bytes, name: fileName, contentType }, { chat_id: chatId, as: deps.context.agentId }) }
}

/**
 * A project chat that keeps its files on its machine (file storage policy): on that machine a file other than an image is
 * published by the host, through the one publisher the composer uses — it stays on the machine, the message pins it.
 * Null when this is not that machine or chat, or for an image (uploaded when sent): the ordinary upload then decides.
 */
async function publishOnHost(args, deps, chatId, message) {
  const publish = deps.context.publishFile
  if (!publish) return null
  const fileName = resolveUploadName(args)
  const contentType = resolveAttachmentMimeType(basename(String(args.file_path)), args.mime_type)
  if (isImageMimeType(contentType)) return null
  const filePath = typeof args?.file_path === 'string' ? args.file_path.trim() : ''
  if (!isAbsolute(filePath)) throw new Error(`message_send_file: file_path must be absolute, got ${filePath}`)
  const target = resolvePath(filePath)
  const info = await stat(target).catch((err) => { throw new Error(`message_send_file: cannot read ${target} (${err?.code || err?.message || 'unknown'})`) })
  if (!info.isFile()) throw new Error(`message_send_file: ${target} is not a file`)
  const sent = await publish(chatId, { name: fileName, path: target, size: info.size, contentType }, deps.context.agentId,
    { ...message, file_name: fileName, content_type: contentType })
  return sent?.message ?? null
}

/** The server's refusal said for people: which machine keeps this project chat's files, and what can be done instead. */
async function keptOnHostRefusal(deps, chatId, fileName) {
  const policy = await deps.restRpc('file_project_policy_for', { p_chat: chatId, p_as: deps.context.agentId }).catch(() => null)
  const account = typeof policy?.host_account_id === 'string' ? policy.host_account_id : null
  // The machine is named by its owner, as a project file's mark names it to the chat's other members.
  const [owner] = account ? await deps.restGet(`users?id=eq.${enc(account)}&select=display_name`, 'identity').catch(() => []) : []
  const ownerName = owner?.display_name || null
  const machine = ownerName ? `${ownerName}'s machine` : 'its host machine'
  const machineZh = ownerName ? `${ownerName} 的机器` : '它绑定的那台机器'
  return `message_send_file: ${fileName} was not sent. This project chat keeps its files on ${machine} and uploads them only when someone opens them, `
    + `so files (other than images) can be shared here only from that machine. Send it from there, or ask ${ownerName ?? 'the machine\'s owner'} to choose `
    + `"Upload everything to the cloud" in Settings › File storage.\n`
    + `${fileName} 没有发出去。这个项目群的文件留在${machineZh}上，有人打开才上传，所以图片以外的文件只能从那台机器发。`
    + `请在那台机器上发，或者请${ownerName ?? '机器主人'}在「设置 › 文件存储与读取」里改成「全部上传到云端」。`
}

async function sendMessageAsOwner(args, deps, content, extra = {}, outcome = { uncertain: false }) {
  const request = {
    p_agent_user_id: deps.context.agentId,
    p_friend_user_id: friendUserIdArg(args.friend_user_id),
    p_content: content,
    p_request_id: randomUUID(),
    ...extra,
  }
  let result
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await deps.restRpc('send_friend_message_as_owner', request)
      break
    } catch (error) {
      const retryable = error instanceof RpcTransportError || (error instanceof RpcHttpError && error.status >= 500)
      if (!(error instanceof RpcHttpError) || error.status >= 500) outcome.uncertain = true
      const fresh = isRefreshableAuthError(error) ? await deps.context.getAccessToken() : null
      if (attempt === 2 || (!retryable && (!fresh || fresh === error.accessToken))) throw error
    }
  }
  if (!result || typeof result.chat_id !== 'string' || !result.chat_id.trim()
    || typeof result.message_id !== 'string' || !result.message_id.trim() || result.sent_by_agent !== true) {
    outcome.uncertain = true
    throw new Error('message_send_as_owner: the server did not confirm the send')
  }
  return JSON.stringify(result)
}

// 一次已经传上去的上传,提交给服务端:回答丢了可能已经发出去了,所以同一次上传、同一个 id(请求号 / 消息 id)重放,
// 服务端按它幂等,最多三次;服务端明确拒的(4xx)不重放。
async function commitWithReplay(commit) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commit()
    } catch (error) {
      if ((error instanceof AttachmentsError && error.status < 500) || attempt === 3) throw error
    }
  }
}

async function handleOwnerFile(args, deps) {
  const friendUserId = friendUserIdArg(args.friend_user_id)
  const { endpoint, fileName, contentType, stagingKey } = await uploadForSend(args, deps, 'message_send_file_as_owner', null)
  // 库里那一半照 send_friend_message_as_owner 的规矩(gugu-supabase send_friend_file_as_owner):发送者是主人,记下是这个 agent 代发。
  const send = { staging_key: stagingKey, friend_user_id: friendUserId, agent_user_id: deps.context.agentId, request_id: randomUUID(), file_name: fileName, content_type: contentType }
  const result = await commitWithReplay(() => sendFileAsOwner(endpoint, send))
  if (typeof result.message_id !== 'string' || result.sent_by_agent !== true) {
    throw new Error('message_send_file_as_owner: the server did not confirm the send')
  }
  return JSON.stringify(result)
}

/**
 * message_download_file { source_message_id }:把一条附件消息的字节下到本机,回本地路径。agent 指的是消息,❌ URL / 桶路径:
 * 先按 agent 本人判看不看得见(agentCanSee),字节从哪来由消息说 —— 老消息正文里的公开 URL,新消息指向群文件夹的那一版
 * (经 attachments/urls 以 agent 的身份签)。本地文件按内容的 sha256 起名(同一份字节只存一份)。
 */
/**
 * 以谁的身份读这条消息的附件:agent 自己看得见就是它(零额外读取);看不见、而这是主人与好友的私聊(#84)
 * 就按主人 —— 与读历史同一个人,看不看得见、签名链接两处都按他。都不成立回 null。
 */
async function attachmentReaderOf(deps, message) {
  if (await agentCanSee(deps, message)) return deps.context.agentId
  if (!(await ownerFriendOfDm(deps, message.chat_id))) return null
  const ownerUserId = await currentAuthUserId(deps)
  return (await agentCanSee(deps, message, ownerUserId)) ? ownerUserId : null
}

async function downloadAttachment(messageId, deps) {
  if (!messageId) throw new Error('message_download_file: source_message_id is required')
  const [message] = await deps.restGet(`messages?id=eq.${enc(messageId)}&select=id,chat_id,content,content_type,file_item_id,file_version,file_blob_id`)
  const readerId = message ? await attachmentReaderOf(deps, message) : null
  if (!readerId) throw new Error(`message_download_file: there is no message ${messageId} you can read`)
  const attachment = message.content_type === 'attachment' ? parseAttachmentContent(message.content, message) : null
  if (!attachment) throw new Error(`message_download_file: message ${messageId} has no attachment`)
  if (attachment.source.kind === 'gone') throw new Error(`message_download_file: the file of message ${messageId} was deleted from the group folder`)
  const file = await deps.resolveFile({ message_id: messageId }, readerId)
  if (file.status !== 'ready') throw new Error(`message_download_file: the file of message ${messageId} is no longer readable`)
  const home = typeof deps.context.guguHome === 'string' ? deps.context.guguHome.trim() : ''
  if (!home) { await file.dispose(); throw new Error('gugu MCP context has no guguHome; cannot save the attachment') }
  const saved = await saveFileHandle(file, joinPath(home, 'chat-media'), attachment.fileName)
  const folder = attachment.source.kind === 'item'
    ? { file: groupFileLink(attachment.source.itemId, { version: attachment.source.version }), next: attachmentFolderLine(attachment.source.itemId, attachment.source.version) }
    : {}
  return JSON.stringify({ source_message_id: `msg:${messageId}`, ...saved, ...folder })
}

/** message_send_file 的 file:群文件夹里一个文件的 gugu-file 链接(?v= 是它的那一版),或者裸的 item_id。 */
function folderFileArg(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const text = String(raw).trim()
  const link = parseGroupFileLink(text) ?? (/^[0-9a-f-]{36}$/i.test(text) ? { itemId: text.toLowerCase() } : null)
  if (!link) throw new Error(`message_send_file: file is a file of the chat's folder, its gugu-file://<item_id>?v=<n> link — not ${JSON.stringify(text)}`)
  return link
}

/** 附件消息的文件名:信封第一行「[附件] 名字 (类型)」(服务端写的,名字按文件夹的规矩规范化过)。 */
function attachmentNameOf(message) {
  return parseAttachmentContent(String(message.content ?? ''), message)?.fileName ?? null
}

/** 历史 / 搜索的一行:附件指着的群文件夹文件写成一个 file 链接(那一版),替掉两列裸 id。 */
function withFolderFile(row) {
  const { file_item_id: itemId, file_version: version, ...rest } = row
  return typeof itemId === 'string' && Number.isInteger(version) ? { ...rest, file: groupFileLink(itemId, { version }) } : rest
}

async function handleFile(args, deps) {
  if (args.action === 'send-file') {
    const chatId = await requireChat(args, deps)
    await assertNotOwnerFriendDm(deps, chatId, 'message_send_file', 'message_send_file_as_owner')
    const toUserIds = await resolveRecipientAddresses(normToList(args.to_user_ids), deps)
    const folderFile = folderFileArg(args.file)
    if (!folderFile && !args.file_path) throw new Error('message_send_file: give file (a file of the chat\'s folder), file_path (a file on this computer), or both')
    if (folderFile && args.file_path && folderFile.version === undefined) {
      throw new Error(`message_send_file: file_path as the next version of ${args.file} needs the version you started from: gugu-file://${folderFile.itemId}?v=<n>`)
    }
    // #3641 附件也是往群里说话:与 message_send 同一道群规闸,在上传任何字节之前判。
    await assertGroupRulesSeen(deps, chatId, 'message_send_file')
    await assertRecipientsAreMembers(chatId, toUserIds, deps)
    const messageId = randomUUID()
    const thread = { thread_root_id: deps.context.threadRootId ?? null }
    let message
    let fileName
    if (folderFile && !args.file_path) {
      // 按引用发:消息钉住群文件夹里那个文件的那一版,不传字节(gugu-supabase attachment_share)。
      const [row] = await deps.restRpc('attachment_share', {
        p_item_id: folderFile.itemId, p_version: folderFile.version ?? null, p_message_id: messageId, p_chat_id: chatId,
        p_sender_user_id: deps.context.agentId, p_to_user_ids: toUserIds ?? [], p_thread_root_id: thread.thread_root_id,
      })
      message = row
      fileName = attachmentNameOf(row ?? {})
    } else if (!folderFile && (message = await publishOnHost(args, deps, chatId, { message_id: messageId, chat_id: chatId,
      sender_user_id: deps.context.agentId, to_user_ids: toUserIds ?? [], ...thread }))) {
      fileName = resolveUploadName(args)
    } else {
      const upload = await uploadForSend(args, deps, 'message_send_file', chatId).catch(async (error) => {
        if (!(error instanceof AttachmentsError && /not uploaded proactively/.test(error.message))) throw error
        throw new Error(await keptOnHostRefusal(deps, chatId, resolveUploadName(args)))
      })
      const { endpoint, contentType, stagingKey } = upload
      fileName = upload.fileName
      const commit = {
        staging_key: stagingKey,
        message_id: messageId,
        chat_id: chatId,
        sender_user_id: deps.context.agentId,
        file_name: fileName,
        content_type: contentType,
        to_user_ids: toUserIds ?? [],
        ...thread,
        // 那个文件的下一版:起点版本对不上(有人先存了新版)服务端就拒,什么都不写。
        ...(folderFile ? { item_id: folderFile.itemId, expected_version: folderFile.version } : {}),
      }
      message = await commitWithReplay(() => commitAttachment(endpoint, commit)).catch((error) => {
        if (!(error instanceof AttachmentsError && error.code === 'version_conflict')) throw error
        throw new Error(`message_send_file: someone stored a newer version of ${args.file} since version ${folderFile.version}, and nothing was sent. Download the current one (message_download_file, or workspace__read with save), make your change on it, and send it with that version.`)
      })
    }
    if (!message?.id) throw new Error('message_send_file: the server did not confirm the send')
    const pinned = typeof message.file_item_id === 'string' && Number.isInteger(message.file_version)
      ? { file: groupFileLink(message.file_item_id, { version: message.file_version }), version: message.file_version }
      : {}
    const blocks = await messageDeliveryBlocks(deps, message.id)
    return JSON.stringify({ status: 'sent', message_id: message.id, file_name: fileName, ...pinned, ...(blocks.length ? { not_delivered_to: blocks, delivery_note: '对方已归档、未送达; retained in history, no replay after restoration' } : {}),
      source_link: conversationLink(chatId, String(message.id).replace(/^msg:/, '')) })
  }
  if (args.action === 'download-attachment') {
    if (args.source_attachment_id) {
      const home = deps.context.guguHome
      if (!home) throw new Error('Gugu home is unavailable')
      return JSON.stringify(await downloadSessionFile(await deps.attachmentsEndpoint(), String(args.source_attachment_id), deps.context.agentId, joinPath(home, 'session-media')))
    }
    return downloadAttachment(String(args.source_message_id ?? ''), deps)
  }
  throw new Error(`gugu_file: unknown action ${args.action}`)
}

// 工具表：每个 action 一个原子工具（#4191 回归 2fb81f0541 的原子形态；域靠名字前缀分组,
// 注册顺序按族聚簇）。导出供单测直接调 handler。
// ACP XML/JSON bridges sometimes serialize array parameters as JSON strings. Accept that shape at
// the schema boundary, then handlers still validate recipients against chat membership (#1064).
// 地址三种写法各是什么、从哪来,平台提示词讲一次;这里只列形态。裸 id、错类型的报错会按参数名说清楚。
const RECIPIENT_ADDRESS_FORMS = 'Typed addresses: "gugu:<number>", "user:<uuid>", or "session:<id>" for a session on this machine.'
// 每个数组外层已经写了 RECIPIENT_ADDRESS_FORMS,元素上不再重复一遍(P5)。
const recipientIdSchema = z.string().refine((value) => value.trim().length > 0, 'Recipient id cannot be blank.')
const toUserIdsSchema = z.preprocess(normalizeRecipientInput, z.array(
  recipientIdSchema,
).optional()).describe('Who to @mention.')
// 正文的规矩只在 message_send 上写一次(P5);别的工具拒收时,报错原话会说清楚。
const CHAT_MESSAGE_TEXT_RULES = 'Message body in Markdown. Visible escaped line breaks and malformed math are rejected.'
const chatMessageTextSchema = z.string()
const chatRecipientsSchema = toUserIdsSchema.describe(`Who you address and notify; multiple recipients allowed. ${RECIPIENT_ADDRESS_FORMS} Plain names in text address nobody; @mentions must match this list.`)
// 话题里点名 = 把人拉进来,所以收件人**必填**:一条谁也没点名的邀请消息拉不进任何人,是静默的空动作。
// 地址形态与 chatRecipientsSchema 同一份契约(RECIPIENT_ADDRESS_FORMS),只是去掉 optional。
const topicInviteeIdsSchema = z.preprocess(normalizeRecipientInput, z.array(recipientIdSchema).min(1)).describe(
  `The people / agents to pull into this topic — at least one, already in the topic's source chat. ${RECIPIENT_ADDRESS_FORMS}`
)
const friendUserIdSchema = z.string().describe('From owner_friends_list.')
// 用法写在字段说明里：顶层描述会被 Claude Code 截到 2048 字符，字段说明不截
// （见 mcp-tool-description-budget.mjs）。这两条正是最容易被用错的地方，必须写在不会被截的那一侧。
// 绝对路径:读不到、不是文件时报错原话会说(readUploadBytes)。常驻工具的预算里省下这一句(#7335)。
const uploadFilePathSchema = z.string().trim().min(1)
const uploadFileNameSchema = z.string().trim().min(1).optional().describe(
  'Default: the name on disk.'
)
const uploadMimeTypeSchema = z.string().optional().describe(
  'Only if the suffix does not tell.'
)

// 成员名录(message_members / topic_members 同一份):按名字、人或 agent、agent 的运行状态筛。
const memberFilterShape = {
  ...listWindowShape,
  type: z.enum(['human', 'agent']).optional(),
  status: agentStatusFilterSchema,
}
const MEMBER_ROWS = {
  key: 'items',
  statusFilter: true,
  namesOf: (row) => [row.display_name],
  keep: (row, args) => (!args.type || row.type === args.type) && matchesAgentStatus(row, args.status),
}

/** def.writer 的写类工具注册 permissive schema,让 harness 常见错误形状先到纠错 preflight、不认识的键点名报回去。集合从 TOOL_DEFS 派生。 */
let MESSAGE_WRITER_TOOLS = new Set()

function preflightGuguMessageArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return
  if ('to' in args || 'message' in args) {
    throw new Error(
      'this tool received the harness SendMessage shape {to, message}. Use one of these legal forms: ' +
      "chat: message_send {chat_id, text}; local session direct: session_message " +
      "{to:['session:<id>' | 'user:<uuid>' | 'gugu:<number>'], text}.",
    )
  }
}

export const TOOL_DEFS = [
  chatActivityTool(resolveChatIdInput),
  // ── message_ ── 聊天消息:写入走 command lease/群规闸/表达一致性,读走 messages_view;附件 = 消息的一种
  {
    name: 'message_send',
    writer: true,
    description: 'Set destination explicitly. reply_to_message_id infers a DM peer or whisper pair; public groups require recipients. Independent, multiple distinct calls allowed. Sessions: session_message.',
    schema: z.object({
      chat_id: chatIdSchema.describe(CHAT_ID_DESCRIPTION),
      to_user_ids: chatRecipientsSchema,
      reply_to_message_id: z.string().min(1).optional().describe('The source message this replies to, in chat_id.'),
      whisper: z.boolean().optional().describe('Only you and one recipient see it; no threads. Whisper replies inherit privacy; false explicitly publishes.'),
      text: chatMessageTextSchema.describe(CHAT_MESSAGE_TEXT_RULES),
    }),
    handler: (args, deps) => handleMessage({ ...args, action: 'send' }, deps),
  },
  {
    name: 'message_send_as_owner',
    writer: true,
    description: 'Send a message as your owner to their DM with a human friend, only when the owner asks; labeled AI-sent.',
    schema: z.object({
      friend_user_id: friendUserIdSchema,
      text: chatMessageTextSchema,
    }),
    handler: async (args, deps) => {
      assertAgentMessageText(args.text, 'message_send_as_owner')
      if (!args.text.trim()) throw new Error('message_send_as_owner: text is required')
      return sendMessageAsOwner(args, deps, args.text)
    },
  },
  {
    name: 'message_invite',
    writer: true,
    description: 'Invite one human or another owner\'s Agent into a group, saying why in text. Humans accept for themselves; an Agent\'s owner accepts for it. Your owner\'s own agents: group_add_agent; topics: topic_invite; status: message_invitations.',
    schema: z.object({ chat_id: chatIdSchema, to_user_ids: z.array(z.string()).length(1), text: chatMessageTextSchema }),
    handler: async (args, deps) => {
      const chatId = await requireChat(args, deps)
      const recipients = await resolveRecipientAddresses(normToList(args.to_user_ids), deps)
      if (recipients?.length !== 1) throw new Error('message_invite requires exactly one recipient')
      return JSON.stringify(await requestGroupInvitation(chatId, recipients[0], args.text, deps))
    },
  },
  {
    name: 'message_invitations',
    description: 'List group invitations sent by this Agent, newest first, including pending, accepted and rejected status. Only the invited human or the external Agent owner can decide an invitation in the app. Pending is not group membership.',
    schema: z.object({ ...listWindowShape }),
    list: { namesOf: (row) => [row.group_name, row.invitee_name] },
    handler: async (_args, deps) => {
      const result = await groupAdmin(deps).invitations(true)
      if (!Array.isArray(result)) throw new Error('message_invitations: expected an invitation list')
      return result
    },
  },
  {
    name: 'contact_friend',
    writer: true,
    description: 'Share yourself with an owner\'s human friend in a group of the owner, you and them. The first text is the invitation: the friend must accept before joining, then it becomes your first message there, so do not resend it; later calls post text there.',
    schema: z.object({
      friend_user_id: friendUserIdSchema,
      text: chatMessageTextSchema,
    }),
    handler: (args, deps) => handleMessage({ ...args, action: 'contact-friend' }, deps),
  },
  {
    name: 'message_history',
    messageRows: true,
    description: 'Read a chat\'s main timeline, or one thread with thread_root_id. Rows carry seq; page back with limit and before_seq.',
    schema: z.object({
      chat_id: chatIdSchema,
      thread_root_id: z.string().optional(),
      limit: z.number().optional(),
      before_seq: z.number().optional().describe('Only messages with seq below this value.'),
    }),
    handler: (args, deps) => handleMessage({ ...args, action: 'history' }, deps),
  },
  {
    name: 'message_search',
    messageRows: true,
    description: 'Search a chat\'s messages, threads and imported history included.',
    schema: z.object({
      query: z.string(),
      chat_id: chatIdSchema,
      // 两格的意思与 message_history 相同,只在那里写一次(P5)。
      limit: z.number().optional(),
      before_seq: z.number().optional(),
    }),
    handler: (args, deps) => handleMessage({ ...args, action: 'search' }, deps),
  },
  {
    name: 'message_members',
    description: 'A chat\'s members: resolve a name (e.g. "Codex 8") to an address for to_user_ids. Unfiltered, total is the headcount; rows:"1" counts.',
    schema: z.object({ chat_id: chatIdSchema, ...memberFilterShape }),
    list: MEMBER_ROWS,
    handler: (args, deps) => handleConv({ ...args, action: 'members' }, deps),
  },
  {
    name: 'message_conversations',
    description: 'Your conversations, most recent message first. owner_dm rows: your owner\'s friend DMs; read only when your owner asks.',
    schema: z.object({
      ...listWindowShape,
      kind: z.enum(['dm', 'group', 'topic', 'ai']).optional(),
      pinned: pinnedFilterSchema,
    }),
    list: {
      // 主人的好友私聊按备注叫,也按好友自己的名字叫(备注之外别人可能只知道后者)。
      namesOf: (row) => [row.name, row.friend_display_name],
      keep: (row, args) => (!args.kind || row.kind === args.kind) && (args.pinned === undefined || row.pinned === args.pinned),
    },
    handler: (args, deps) => handleConv({ ...args, action: 'list' }, deps),
  },
  {
    name: 'message_rules',
    description: 'Read a group\'s rules. Reading them here or as <group_rules> in a delivery counts as read; message_send refuses to post in a group before you have read the current version. A message_history hint after a new join is advisory and never blocks sending.',
    schema: z.object({ chat_id: chatIdSchema }),
    handler: (args, deps) => handleConv({ ...args, action: 'rules' }, deps),
  },
  {
    name: 'message_send_file',
    writer: true,
    description: 'File delivery tool: post a file card. file: a chat-folder file by its gugu-file://<id>?v=<n> link (no bytes copied); with file_path, your changed copy as its next version from n. file_path alone: a new file.',
    schema: z.object({
      file: z.string().optional(),
      file_path: uploadFilePathSchema.optional(),
      file_name: uploadFileNameSchema,
      mime_type: uploadMimeTypeSchema,
      to_user_ids: toUserIdsSchema,
      chat_id: chatIdSchema,
    }),
    handler: (args, deps) => handleFile({ ...args, action: 'send-file' }, deps),
  },
  {
    name: 'message_send_file_as_owner',
    writer: true,
    description: 'Send a local file or image as your owner to their DM with a human friend, only when the owner asks; labeled AI-sent.',
    schema: z.object({
      friend_user_id: friendUserIdSchema,
      file_path: uploadFilePathSchema,
      file_name: uploadFileNameSchema,
      mime_type: uploadMimeTypeSchema,
    }),
    handler: (args, deps) => handleOwnerFile(args, deps),
  },
  {
    name: 'message_download_file',
    description: 'Download original bytes from a visible chat message (source_message_id) or a session-message attachment reference (source_attachment_id). Returns file_path, actual size_bytes and full sha256; session files are verified against their reference.',
    schema: z.object({ source_message_id: z.string().optional(), source_attachment_id: z.string().uuid().optional() }).refine(args => Boolean(args.source_message_id) !== Boolean(args.source_attachment_id), 'Give exactly one attachment source'),
    handler: (args, deps) => handleFile({ ...args, action: 'download-attachment' }, deps),
  },
  // ── topic_ ── 话题:从一条已有消息长出来的独立工作线。它本身就是一条 chat,所以收发/读历史仍走
  // message_*；删除必须由来源群管理员带上当前名称，由数据库校验。
  {
    name: 'topic_open',
    writer: true,
    description: 'Open a topic from a message. Only participants are notified. Messages use its chat_id; files and Apps use the source chat. Deletion: catalog topic_delete.',
    schema: z.object({
      chat_id: chatIdSchema.describe('The source chat.'),
      source_message_id: z.string().trim().min(1).describe('A message of chat_id (msg:<uuid>).'),
      name: z.string().optional().describe('Default: the source message\'s start.'),
      to_user_ids: chatRecipientsSchema.describe('Who to bring in: members of the source chat only.'),
    }),
    handler: (args, deps) => handleTopic({ ...args, action: 'open' }, deps),
  },
  {
    name: 'topic_list',
    description: 'The topics of one chat; is_participant: whether you are in it (only participants are notified). Check here before opening a second line for a question.',
    schema: z.object({
      chat_id: chatIdSchema.describe('The source chat.'),
      ...listWindowShape,
      participating: z.boolean().optional(),
    }),
    list: {
      namesOf: (row) => [row.name],
      keep: (row, args) => args.participating === undefined || row.is_participant === args.participating,
    },
    handler: (args, deps) => handleTopic({ ...args, action: 'list' }, deps),
  },
  {
    name: 'topic_delete',
    writer: true,
    description: 'Delete a topic for everyone. You must be an owner/admin of its source group and confirm_name must exactly match its current name, including case and whitespace. The database enforces both checks.',
    schema: z.object({
      chat_id: chatIdSchema.describe('The topic itself, from topic_list.'),
      confirm_name: z.string().min(1).describe('The exact current topic name. Do not trim, normalize or change it.'),
    }),
    handler: (args, deps) => handleTopic({ ...args, action: 'delete' }, deps),
  },
  {
    name: 'topic_members',
    description: 'Who is participating in one topic and on what listen_mode: user_id + display_name + type + gugu_number + role + listen_mode + is_self — the same shape message_members returns for any chat. Use it to see who is already in before you pull anyone else in with topic_invite, and to resolve a readable name to the address you pass in to_user_ids.',
    schema: z.object({
      chat_id: chatIdSchema.describe(`The TOPIC's own chat_id, from topic_open or topic_list.`),
      ...memberFilterShape,
    }),
    list: MEMBER_ROWS,
    // 与 message_members 同一个 handler:形状必须逐字段一样,抄一份实现出来就是造一个会漂移的副本。
    // 但**入参要自己校**:topic_list 收的是来源线 id、topic_members 收的是话题自己的 id,
    // 两者都是 uuid,传串了原先零报错地回整个群的名单 —— agent 据此以为一屋子人都在话题里。
    // topic_invite 对同一个错误早就是 fail-loud,同一条产品规则不许一个响一个哑。
    handler: async (args, deps) => {
      await assertIsTopic(args, deps, 'topic_members')
      return handleConv({ ...args, action: 'members' }, deps)
    },
  },
  {
    name: 'topic_invite',
    writer: true,
    description: 'Pull people / agents already in the source line into a topic, by posting one message in the topic that addresses them. Addressing them IS the invitation: whoever is named becomes a participant and starts getting its notifications from this message onwards — there is no separate membership switch, and a plain unaddressed message invites nobody. text is required and should say why you are pulling them in, because that message is the first thing they see. Only people who are already in the topic\'s source chat can be pulled in: an agent regroups the owner\'s existing contacts, it never adds new ones. Afterwards just use message_send with this chat_id.',
    schema: z.object({
      chat_id: chatIdSchema.describe(`The TOPIC's own chat_id, from topic_open or topic_list. A group or private chat is refused: "being named pulls you in" only holds inside a topic.`),
      to_user_ids: topicInviteeIdsSchema,
      text: chatMessageTextSchema.describe('The message that pulls them in — say why you need them and what you want from them. Required: an empty invitation wastes the one message they are guaranteed to see.'),
    }),
    handler: (args, deps) => handleMessage({ ...args, action: 'topic-invite' }, deps),
  },
  // ── group_ ── #6492 主人所在的群:列、进、改群资料。拉人或别人的 agent 仍走 message_invite(要对方同意)。
  // 何时用靠平台提示词里「不替主人扩大社交圈」那条约束(product spec:prompt 层,不加机制)。
  {
    name: 'group_list',
    description: 'List the active groups your owner is in, most recent message first, so you can join one or add another of your owner\'s agents with group_add_agent. Each row: chat_id, public_id, name, member_count, joined (whether you are already a member), pinned (your owner pinned it) and agent_join_needs_approval (the group requires approval for Agents and your owner is neither its owner nor an admin, so group_add_agent returns pending_approval until one of them approves). Nothing of a group\'s messages is shown here.',
    schema: z.object({
      ...listWindowShape,
      joined: z.boolean().optional(),
      pinned: pinnedFilterSchema,
    }),
    list: {
      namesOf: (row) => [row.name],
      keep: (row, args) => (args.joined === undefined || row.joined === args.joined)
        && (args.pinned === undefined || row.pinned === args.pinned),
    },
    handler: (args, deps) => handleGroup({ ...args, action: 'list' }, deps),
  },
  {
    name: 'group_add_agent',
    writer: true,
    description: 'Add yourself or one of your owner’s Agents to a group. Omit agent to add yourself. Uses your own group role; agent approval still applies. Returns joined, pending_approval or already_member. Other identities use message_invite.',
    schema: z.object({
      chat_id: chatIdSchema.describe(`The group to join, from group_list.`),
      agent: z.string().trim().min(1).optional().describe('Optional: the agent to add when it is not you — one of your owner\'s agents as "aid:<Agent ID>" (or its older spelling "user:<uuid>"), "gugu:<number>", or "session:<id>" for a session on this machine (from session_spawn / session_children / session_peers). Omit it to add yourself.'),
    }),
    handler: (args, deps) => handleGroup({ ...args, action: 'add-agent' }, deps),
  },
  {
    name: 'group_create',
    writer: true,
    description: 'Create a group with your human owner as its sole owner and you as an admin, using the app\'s group-creation path. Your owner\'s agents join directly; people and other owners\' agents receive invitations and join only after acceptance. Returns chat_id, direct member_user_ids, invitations and invitation_errors. If an invitation fails, the group still exists: use its chat_id to retry with message_invite.',
    schema: z.object({
      name: z.string().trim().min(1).describe('Group name.'),
      members: z.array(z.string().trim().min(1)).optional().describe('Optional members as user:<uuid> / aid:<Agent ID>, gugu:<number>, or session:<id> on this machine. Your owner and you are always included. Invitations say: 邀请你加入群聊「<name>」。'),
    }),
    handler: (args, deps) => handleGroup({ ...args, action: 'create' }, deps),
  },
  {
    name: 'group_update', writer: true,
    description: 'Change group settings as yourself. Requires your own group admin role. Pass only the changes you intend; rules is the group rules text. Empty rules or description clears it.',
    schema: z.object({ chat_id: chatIdSchema, changes: z.object({
      name: z.string().trim().min(1).optional(), description: z.string().optional(), rules: z.string().optional(),
      join_mode: z.enum(['open', 'approval', 'invite_only']).optional(), allow_member_invite: z.boolean().optional(),
      agent_join_approval: z.boolean().optional(), invite_link_enabled: z.boolean().optional(),
      max_members: z.number().int().min(1).optional(), hide_history: z.boolean().optional(),
      agent_flood_threshold: z.number().int().min(1).nullable().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, 'Pass at least one change') }),
    handler: (args, deps) => handleGroup({ ...args, action: 'update' }, deps),
  },
  {
    name: 'group_leave', writer: true,
    description: 'Leave one group yourself. No approval is needed. Your session keeps running; you stop receiving this group. You cannot use it to remove another member.',
    schema: z.object({ chat_id: chatIdSchema }), handler: (args, deps) => handleGroup({ ...args, action: 'leave' }, deps),
  },
  {
    name: 'group_remove_member', writer: true,
    description: 'Remove one group member as an admin. People, Agents and other admins can be removed; the human group owner cannot.',
    schema: z.object({ chat_id: chatIdSchema, member: z.string().trim().min(1).describe('The member as user:<uuid>, gugu:<number>, aid:<Agent ID>, or session:<id> on this machine.') }),
    handler: (args, deps) => handleGroup({ ...args, action: 'remove' }, deps),
  },
  {
    name: 'group_set_role', writer: true,
    description: 'Set one group member to admin or member, as an admin yourself. The group owner cannot be changed or demoted.',
    schema: z.object({ chat_id: chatIdSchema, member: z.string().trim().min(1).describe('The member as user:<uuid>, gugu:<number>, aid:<Agent ID>, or session:<id> on this machine.'), role: z.enum(['admin', 'member']) }),
    handler: (args, deps) => handleGroup({ ...args, action: 'role' }, deps),
  },
  {
    name: 'group_join_requests',
    description: 'List group join requests as an admin. Pending by default; status all includes accepted and rejected requests. This is separate from invitations you sent.',
    schema: z.object({ chat_id: chatIdSchema, ...listWindowShape, status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('pending') }),
    list: { namesOf: (row) => [row.requester_name], keep: (row, args) => args.status === 'all' || row.status === (args.status ?? 'pending') },
    handler: (args, deps) => handleGroup({ ...args, action: 'join-requests' }, deps),
  },
  {
    name: 'group_join_decide', writer: true,
    description: 'Accept or reject one group join request as an admin. The request determines its group; approval does not substitute for an invited person or Agent owner consenting.',
    schema: z.object({ request_id: z.string().min(1).describe('The existing join request returned by group_join_requests.'), accept: z.boolean() }),
    handler: (args, deps) => handleGroup({ ...args, action: 'join-decide' }, deps),
  },
  {
    name: 'group_info', description: 'Read group settings, your role and whether you may manage it. Management uses your own role, not your owner’s.',
    schema: z.object({ chat_id: chatIdSchema }), handler: (args, deps) => handleGroup({ ...args, action: 'info' }, deps),
  },
  {
    name: 'group_avatar_set', writer: true, description: 'Upload and set a group avatar as an admin. Use an absolute image path, at most 5 MB.',
    schema: z.object({ chat_id: chatIdSchema, file_path: uploadFilePathSchema }), handler: (args, deps) => handleGroup({ ...args, action: 'avatar' }, deps),
  },
  {
    name: 'group_announcement_post', writer: true, description: 'Post a group announcement as an admin. A normal chat message is not an announcement.',
    schema: z.object({ chat_id: chatIdSchema, text: chatMessageTextSchema }), handler: (args, deps) => handleGroup({ ...args, action: 'announcement-post' }, deps),
  },
  {
    name: 'group_announcement_update', writer: true, description: 'Edit or pin a group announcement as an admin. Pass text, pinned, or both.',
    schema: z.object({ announcement_id: z.string().min(1), changes: z.object({ text: z.string().trim().min(1).optional(), pinned: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0) }),
    handler: (args, deps) => handleGroup({ ...args, action: 'announcement-update' }, deps),
  },
  {
    name: 'group_announcement_delete', writer: true, description: 'Delete one group announcement as an admin.',
    schema: z.object({ announcement_id: z.string().min(1) }), handler: (args, deps) => handleGroup({ ...args, action: 'announcement-delete' }, deps),
  },
  {
    name: 'group_flood_undo', writer: true, description: 'Undo one system automatic passive adjustment as a group member. Restores only that recorded change; it cannot choose an Agent’s listen mode.',
    schema: z.object({ adjustment_id: z.string().min(1) }), handler: (args, deps) => handleGroup({ ...args, action: 'flood-undo' }, deps),
  },
  // ── profile_ ── 自己的资料 + 咕咕号解析
  {
    name: 'profile_whoami',
    description: 'Your profile, owner, and groups with your role and listen_mode. Your name can change: read it here.',
    schema: z.object({}),
    handler: (args, deps) => handleProfile({ ...args, action: 'whoami' }, deps),
  },
  {
    name: 'owner_friends_list',
    description: 'The owner\'s human friends. Their user_id goes to message_send_as_owner / message_send_file_as_owner or contact_friend.',
    schema: z.object({ ...listWindowShape, pinned: pinnedFilterSchema }),
    list: {
      namesOf: (row) => [row.display_name, row.owner_remark],
      keep: (row, args) => args.pinned === undefined || row.pinned === args.pinned,
    },
    handler: (args, deps) => handleProfile({ ...args, action: 'owner-friends' }, deps),
  },
  {
    name: 'profile_update',
    writer: true,
    description: 'Update your own gugu profile: set any of display_name / avatar / bio.',
    schema: z.object({
      display_name: z.string().optional(),
      avatar: z.string().optional(),
      bio: z.string().nullable().optional(),
    }),
    handler: (args, deps) => handleProfile({ ...args, action: 'update' }, deps),
  },
  {
    name: 'profile_lookup',
    description: 'Resolve a Gugu identity someone gave you — pass the canonical user:<uuid> address or a numeric Gugu number. A person or public agent, anywhere, not only in this chat, is returned with their user: id, name and type, plus whether they are already one of the owner\'s contacts. A number is also addressable directly as gugu:<number> in to_user_ids / session_message without this lookup. Messaging still needs a shared chat or a local session route.',
    schema: z.object({
      // 数字与两种 typed 身份短址都如实广告(union ⇒ anyOf):只广告 integer 会让校验入参的 harness 把
      // agent 从信封/名录里抄来的地址挡在门外。
      gugu_number: z.union([
        z.coerce.number().int().positive(),
        z.string().regex(/^\s*gugu:[1-9][0-9]{0,8}\s*$/),
        z.string().regex(/^\s*user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\s*$/i),
      ]).describe('The identity address you were given — as user:<uuid>, a number (8), or the typed address gugu:8 (people and agents both have one once public).'),
    }),
    handler: (args, deps) => handleConv({ ...args, action: 'lookup' }, deps),
  },
  // ── session_(本机名录;session_* 其余工具在 gugu-session-tool.ts)──
  // 集体记忆对账第 9 条：session_message 也收 session:<sessionId>(gugu-session-tool.ts 的 to;跨机器 DESIGN.md:23),
  // 和第 2 条同一个源头 —— 寻址说法别再停在「session: 只在本项目、跨项目用 aid:」。
  {
    name: 'session_peers',
    description: 'Sessions on this machine (or another, with device), most recent first. Address one as session:<sessionId>, aid:<Agent ID> or gugu:<gugu_number> from its row — never a bare id or a name.',
    schema: z.object({
      ...listWindowShape,
      // device 的写法在 session_spawn 上写一次(P5)。
      device: z.string().min(1).optional(),
      project: z.string().optional().describe('Project name contains this.'),
      status: agentStatusFilterSchema,
      pinned: pinnedFilterSchema,
    }),
    list: {
      namesOf: (row) => [row?.title, row?.identity?.users?.display_name],
      statusFilter: true,
      keep: (row, args) => (!args.project || String(row?.project ?? '').toLocaleLowerCase().includes(args.project.trim().toLocaleLowerCase()))
        && matchesAgentStatus(row, args.status)
        && (args.pinned === undefined || row?.pinned === args.pinned),
    },
    handler: async (args, deps) => {
      if (!deps.context.runHostAction) throw new Error('local peers host bridge is unavailable')
      // 跨机器(owner 2026-09-30):device 在这里解成裸 id,宿主按它把名录请求交给那台机器。
      const device = args.device === undefined ? undefined : decodeTypedId('device', args.device, 'device')
      const result = await deps.context.runHostAction(device === undefined ? { action: 'peers' } : { action: 'peers', device })
      if (!Array.isArray(result)) throw new Error('local peers host returned a non-directory result')
      // 名录不按调用者过滤,调用者自己那一行也在里面:与 message_members 同一判据标出来,别把读者当第三方呈现给他自己(#5947)。
      return result.map((row) => ({ ...row, is_self: row?.identity?.users?.id === deps.context.agentId }))
    },
  },
  ...FORUM_TOOL_DEFS,
]

MESSAGE_ROW_TOOLS = new Set(TOOL_DEFS.filter((d) => d.messageRows).map((d) => d.name))
MESSAGE_WRITER_TOOLS = new Set(TOOL_DEFS.filter((d) => d.writer).map((d) => d.name))

async function dispatchTool(context, name, args, injected, state) {
  const def = TOOL_DEFS.find((d) => d.name === name)
  if (!def) throw new Error(`unknown tool: ${name}`)
  if (MESSAGE_WRITER_TOOLS.has(name)) preflightGuguMessageArgs(args)
  // 运行时分叉(侧边聊天)把这组工具**注册了但不许执行**。
  //
  // 为什么注册了还要拒:工具清单在模型前缀里,少一个工具前缀就变,分叉继承来的那整段上下文便
  // 命中不了缓存 —— 而侧边聊天多是随手问询,不该为此每次全价重算。所以缓存靠「照常注册」保住,
  // 边界靠这道闸守住。❌ 别改回「不注册」来实现「不许用」。
  //
  // 为什么必须拒:分叉不落库、没有咕咕身份(#3805),一执行就等于以来源 agent 的名义对外发言。
  // 闸放在业务分派口而不是 SDK handler 里:SDK 那层会先做参数校验,参数不合法时根本轮不到我们
  // 说话;而且导出的 callTool 也走这里,两条路一道闸。
  // 与既有的「没读群规即拒」同形状:光在提示里教不够,得有闸。
  // ⚠️ 只挡 TOOL_DEFS 这组 IM 工具;session_* / app_* 另外注册,照常可用。
  if (context?.forkOf !== undefined) {
    const who = context.forkOf || '来源会话'
    throw new Error(
      `这条会话是「${who}」的运行时分叉(会话页的「侧边」):它不落库、没有咕咕身份,` +
      `因此不能以 ${who} 的名义收发消息 —— IM 工具在这里一律不执行。` +
      `把答案直接说给当前用户即可;文件、shell,以及 session_*/app_* 的会话管理工具照常` +
      `(session_peers 属 IM 名录,同样不执行)。`
    )
  }
  // The id boundary lives here, on the one path both the SDK server and the exported callTool take.
  const decoded = decodeImArgs(args || {})
  const out = await def.handler(decoded, createDeps(context, injected, state))
  if (def.rawOutput) return out
  // 列表工具(def.list)的 handler 回整张排好序的表,在这里按 list-window 的约定切窗(与 sessionpage 注册机同一个函数)。
  return encodeImOutput(name, decoded, def.list ? JSON.stringify(windowResult(def.list, out, decoded)) : out)
}

// 业务分派（导出供单测：value-based context，不经 SDK transport）。
export async function callTool(context, name, args, deps = {}) {
  return dispatchTool(context, name, args, deps, createSessionState())
}

// 一条**会话**的状态跨调用活着(createGuguImServer 里就是这样),而 callTool 每次都现造一份。
// 记忆化的缺陷(把一次读不到记成终身结论)只在跨调用复用同一份 state 时才显形,所以判官要拿得到它。
export { createSessionState }
export async function callToolWithState(context, name, args, deps, state) {
  return dispatchTool(context, name, args, deps, state)
}

// ── MCP server（官方 SDK） ─────────────────────────────────────────
// 不连 transport——便于单测用 InMemoryTransport 接客户端；deps 可注入免 live REST。
export function createGuguImServer(getContext, deps = {}) {
  const server = new McpServer({ name: GUGU_MCP_SERVER_NAME, version: '0.3.0' })
  const state = createSessionState()
  for (const def of TOOL_DEFS) {
    const permissive = MESSAGE_WRITER_TOOLS.has(def.name)
    registerGuguTool(server, { ...def, permissive, preflight: permissive ? preflightGuguMessageArgs : undefined }, async (toolArgs, requestSignal) => {
      const signal = deps.signal
        ? AbortSignal.any([deps.signal, requestSignal])
        : requestSignal
      const current = getContext()
      const context = {
        ...current,
        getAccessToken: () => current.getAccessToken(signal),
        ...(current.runHostAction
          ? { runHostAction: (action) => current.runHostAction(action, signal) }
          : {}),
      }
      const fetchImpl = deps.fetch ?? fetch
      const out = await dispatchTool(context, def.name, toolArgs, {
        ...deps,
        fetch: (input, init) => fetchImpl(input, { ...init, signal }),
      }, state)
      return { content: [{ type: 'text', text: String(out) }] }
    }, deps.trackRequest)
  }
  // tools/list 由组装这台 server 的宿主装一次(acp-engine-utils:session_* / app_* 等域注册完之后),❌ 在这里先装一个
  // 再被覆盖 —— 那一个在产品里从来不生效。
  return server
}

/**
 * 一个已注册工具对模型的样子。TOOL_DEFS 项用真 schema 覆盖(permissive 注册的写类工具否则会广告成无字段的 object),写类广告严格的那份。
 * `$schema` 不广告:每个工具都带同一句 draft-07 URL,MCP 不要求它、模型用不上;Claude 开场 31 个工具为它付 ≈0.7k token,
 * codex 本来就自己去掉(上下文工程第一批,2026-10-07 实测)。
 */
export function advertisedTool(name, tool) {
  const def = TOOL_DEFS.find((candidate) => candidate.name === name)
  const inputSchema = toJsonSchemaCompat(
    def ? (def.writer ? def.schema.strict() : def.schema) : tool.inputSchema,
    {
      strictUnions: true,
      pipeStrategy: 'input',
    },
  )
  delete inputSchema.$schema
  return { name, description: tool.description, inputSchema }
}

// tools/list 必须枚举 **_registeredTools**,❌ 不能只 map TOOL_DEFS:session_*/app_* 两域是
// 在 createGuguImServer 返回之后注册进同一台 server 的,只 map 本域会把那 15 个工具从清单里藏掉——可调用但模型
// 看不见,等于没有(mcp 车道 2026-08-25 实测抓到)。`listed` 只决定列不列,不决定能不能调。
export function serveToolsList(server, getContext, listed = () => true) {
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = Object.entries(server._registeredTools)
      .filter(([name]) => listed(name))
      .map(([name, tool]) => advertisedTool(name, tool))
    const context = getContext()
    log.info({
      transport: context.transport ?? null,
      tools: tools.map((tool) => tool.name),
    }, 'tools/list response')
    return { tools }
  })
}
