/**
 * 论坛来源:agent 收件箱读者的第二个云端来源(第一个是聊天)。被指派到帖子上的 agent,由库里的帖内事件序列告诉它
 * 该看什么 —— 哪几件事叫醒哪个 agent 只由库里的 `public.forum_event_wakes_agent` 回答(入队与拉取共用),这里不做资格判断。
 *
 * 一行事件 = 读者的一行(`AgentInboxUnreadRow.forum`),信封在这里一次做好;受理后按帖子确认到这一批的最大 seq
 * (`forum_ack`),失败记在那条指派上(`forum_record_delivery_failure`,主人在帖子里看到),❌ 写成一条回复。
 */
import { createHash } from 'node:crypto'
import { getSupabaseAnonKey, getSupabaseUrl } from '../../cloud/config'
import { encodeTypedId } from '../../shared/typedId.mjs'
import { buildForumEnvelope, formatDeliveryTimestamp } from './deliveryEnvelope'
import type { AgentInboxUnreadRow } from './agentInboxReader'

/** forum_pull_agent_inbox 的一行。 */
interface ForumInboxRpcRow {
  post_id: string
  seq: number | string
  kind: 'assigned' | 'reply' | 'settled'
  entity_id: string | null
  actor_user_id: string | null
  actor_name: string | null
  actor_is_agent: boolean | null
  created_at: string
  post_title: string
  post_body: string
  post_author_id: string | null
  post_author_name: string | null
  bounty: ForumBounty | null
  reply_body: string | null
  reply_to_poster_only: boolean | null
  reply_to: string | null
  reply_count: number
}

interface ForumBounty {
  amount: number
  visibility: 'public' | 'poster_only'
  deadline_at: string
  status: 'open' | 'awarded' | 'refunded' | 'burned'
  awards: Array<{ user_id: string; reply_id: string; amount: number }>
}

export type ForumDeliveryFailure = 'undelivered' | 'turn_failed'

async function forumRpc(name: string, body: Record<string, unknown>, accessToken: string): Promise<unknown> {
  const response = await fetch(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${name} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

export async function fetchForumUnreadViaRpc(agentUserId: string, accessToken: string): Promise<AgentInboxUnreadRow[]> {
  const rows = await forumRpc('forum_pull_agent_inbox', { p_agent: agentUserId }, accessToken)
  if (!Array.isArray(rows)) throw new Error('forum_pull_agent_inbox returned a non-list result')
  return (rows as ForumInboxRpcRow[]).map(forumRowFromRpc)
}

export async function ackForumViaRpc(input: { agentUserId: string; postId: string; seq: number }, accessToken: string): Promise<void> {
  await forumRpc('forum_ack', { p_agent: input.agentUserId, p_post_id: input.postId, p_seq: input.seq }, accessToken)
}

export async function recordForumFailureViaRpc(
  input: { agentUserId: string; postId: string; state: ForumDeliveryFailure; error: string },
  accessToken: string,
): Promise<void> {
  await forumRpc('forum_record_delivery_failure', {
    p_agent: input.agentUserId, p_post_id: input.postId, p_state: input.state, p_error: input.error,
  }, accessToken)
}

/** 帖子 + 帖内序号 ⇒ 这件事的稳定 id(重投时同一个),uuid 形状。 */
export function forumEventId(postId: string, seq: number): string {
  const hex = createHash('sha256').update(`forum:${postId}:${seq}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function bountyLine(bounty: ForumBounty | null): string | null {
  if (!bounty) return null
  const answers = bounty.visibility === 'poster_only' ? 'answers seen by the poster only until it settles' : 'answers public'
  if (bounty.status === 'open') return `bounty ${bounty.amount} points, ${answers}, open until ${formatDeliveryTimestamp(bounty.deadline_at)}`
  return `bounty ${bounty.amount} points, settled (${bounty.status})`
}

function settlementText(bounty: ForumBounty | null): string {
  if (!bounty) return 'The post was settled.'
  if (bounty.status === 'awarded') {
    const awards = bounty.awards.map((award) => `${encodeTypedId('reply', award.reply_id)} (${award.amount} points)`).join(', ')
    return `The bounty was settled: the poster accepted ${awards}. Answers that were for the poster only are now public.`
  }
  if (bounty.status === 'refunded') return 'The bounty ended with no answers; the points went back to the poster.'
  return 'The bounty ended without an accepted answer; its points are gone. Answers that were for the poster only are now public.'
}

export function forumRowFromRpc(raw: ForumInboxRpcRow): AgentInboxUnreadRow {
  const seq = Number(raw.seq)
  const id = forumEventId(raw.post_id, seq)
  const post = encodeTypedId('post', raw.post_id)
  const author = raw.post_author_name ?? 'someone'
  const parts = [`Forum post "${raw.post_title}" by ${author}`, bountyLine(raw.bounty)]
  let content: string
  if (raw.kind === 'assigned') {
    parts.push(`${raw.actor_name ?? 'your owner'} assigned you to it`, `${raw.reply_count} replies so far — read them with forum_read`)
    content = raw.post_body
  } else if (raw.kind === 'reply') {
    if (!raw.entity_id || raw.reply_body === null) throw new Error(`forum reply event ${post}#${seq} has no reply it can show`)
    parts.push(
      `new reply ${encodeTypedId('reply', raw.entity_id)}${raw.reply_to_poster_only ? ' (for the poster only)' : ''}`,
      ...(raw.reply_to ? [`in reply to ${encodeTypedId('reply', raw.reply_to)}`] : []),
    )
    content = raw.reply_body
  } else {
    content = settlementText(raw.bounty)
  }
  const envelope = buildForumEnvelope({
    eventId: id,
    postId: raw.post_id,
    from: raw.actor_name,
    fromId: raw.actor_user_id ? encodeTypedId('user', raw.actor_user_id) : null,
    at: formatDeliveryTimestamp(raw.created_at),
    context: parts.filter((part): part is string => Boolean(part)).join(' · '),
    content,
  })
  return {
    // 只用来在读者里按帖子分组与排序(没有 chat):`forum:<post>` 不是任何 chat 的 id,也不会被当成 chat 送出去。
    chatId: `forum:${raw.post_id}`,
    chatKind: null,
    chatPublicId: null,
    chatName: null,
    chatCreatorUserId: null,
    listenMode: null,
    notificationLevel: null,
    lastReadSeq: 0,
    id,
    seq,
    senderUserId: raw.actor_user_id,
    senderType: raw.actor_is_agent ? 'agent' : 'human',
    senderDisplayName: raw.actor_name,
    senderGuguNumber: null,
    content,
    contentType: 'text',
    toUserIds: null,
    isWhisper: false,
    replyToMessageId: null,
    replyToSenderUserId: null,
    replyToContent: null,
    threadRootId: null,
    isThreadRoot: false,
    createdAt: raw.created_at,
    forum: { postId: raw.post_id, seq, envelope },
  }
}
