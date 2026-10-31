import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { rendererLogger } from './log'
import { chatDb } from './supabase'
import { messageForUser } from './userFacingError'

const shareLog = rendererLogger('contacts/share-agent')

// @@@6524 分享 Agent 给好友 = MCP contact_friend 同一条链(product spec「agent 联系主人的好友」):
// 每位好友一次 request_agent_friend_contact —— 建或复用「主人 + Agent」小群、给好友发入群邀请,好友同意后才成为成员;
// 已有完整小群直接复用;好友拒绝过的只回 rejected,不重发。
// ❌ 回到 get_or_create_agent_channel:它建 agent 当群主的群,#2051 起必撞「exactly 1 human owner」。

export type AgentShareOutcome =
  | { friendUserId: string; status: 'pending' | 'rejected' }
  | { friendUserId: string; status: 'already_member'; chatId: string; name: string }
  | { friendUserId: string; status: 'failed'; error: unknown }

async function inviteFriend(agentUserId: string, friendUserId: string, note: string): Promise<AgentShareOutcome> {
  const { data, error } = await chatDb.rpc('request_agent_friend_contact', {
    p_agent_user_id: agentUserId,
    p_friend_user_id: friendUserId,
    p_message: note,
  })
  if (error) throw error
  const row = (Array.isArray(data) ? data[0] : data) as { status?: unknown; chat_id?: unknown; name?: unknown } | null
  if (row?.status === 'pending' || row?.status === 'rejected') return { friendUserId, status: row.status }
  if (row?.status === 'already_member' && typeof row.chat_id === 'string') {
    // 群名只是打开会话时的乐观标题(MCP 同一 RPC 也按可空处理);缺了照样算已在小群里,名字缺失走 fail-loud 日志。
    const name = resolveOrLoud(typeof row.name === 'string' ? row.name : null, `share-agent group name ${row.chat_id}`)
    return { friendUserId, status: 'already_member', chatId: row.chat_id, name }
  }
  throw new Error(`request_agent_friend_contact returned unexpected row for ${friendUserId}: ${JSON.stringify(row)}`)
}

/** 每位好友各发一次;某位失败不拦其他人,结果按选中顺序逐位返回,由界面说清谁成了、谁没成。 */
export function shareAgentWithFriends(
  agentUserId: string,
  friendUserIds: readonly string[],
  note: string,
): Promise<AgentShareOutcome[]> {
  return Promise.all([...new Set(friendUserIds)].map((friendUserId) =>
    inviteFriend(agentUserId, friendUserId, note).catch((error: unknown): AgentShareOutcome => {
      // 界面只给用户能用上的那句话,原文进日志(Error 直接进日志会被序列化成 {},取 message)。
      const detail = error instanceof Error ? error.message : JSON.stringify(error)
      shareLog.error({ agentUserId, friendUserId, error: detail }, 'share agent invitation failed')
      return { friendUserId, status: 'failed', error }
    }),
  ))
}

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface AgentShareReport {
  /** 成了的那几句(已发邀请 / 已在小群里),按条给提示。 */
  done: string[]
  /** 没成的那一句;全成了为 null。 */
  problem: string | null
  /** 值得重试的好友:只有失败的。拒绝过的重发也不会再发(RPC 只回 rejected),不留在选中里。 */
  retryIds: string[]
  /** 只分享给一位好友、且你们已在小群里 ⇒ 直接打开那个群。 */
  openGroup: { id: string; name: string } | null
}

// @@@6524 分享结果 → 用户看到的话。名字按当前语言连接(`Intl.ListFormat`,❌ 把分隔符做成词条)。
export function describeAgentShare(
  outcomes: readonly AgentShareOutcome[],
  nameOf: (friendUserId: string) => string,
  t: Translate,
  language: string,
): AgentShareReport {
  const list = new Intl.ListFormat(language, { style: 'long', type: 'conjunction' })
  const names = (status: AgentShareOutcome['status']): string | null => {
    const picked = outcomes.filter((outcome) => outcome.status === status).map((outcome) => nameOf(outcome.friendUserId))
    return picked.length > 0 ? list.format(picked) : null
  }
  const sent = names('pending')
  const joined = names('already_member')
  const rejected = names('rejected')
  const failed = outcomes.filter((outcome): outcome is Extract<AgentShareOutcome, { status: 'failed' }> => outcome.status === 'failed')

  const done: string[] = []
  if (sent) done.push(t('inviteAgent.sent', { ns: 'contacts', names: sent }))
  if (joined) done.push(t('inviteAgent.alreadyInGroup', { ns: 'contacts', names: joined }))

  const problems: string[] = []
  if (rejected) problems.push(t('inviteAgent.rejected', { ns: 'contacts', names: rejected }))
  if (failed.length > 0) {
    problems.push(t('inviteAgent.failedFor', { ns: 'contacts', names: list.format(failed.map((outcome) => nameOf(outcome.friendUserId))) }))
    const hint = messageForUser(failed[0].error)
    if (hint) problems.push(hint)
  }

  const only = outcomes.length === 1 ? outcomes[0] : null
  return {
    done,
    problem: problems.length > 0 ? problems.join(' ') : null,
    retryIds: failed.map((outcome) => outcome.friendUserId),
    openGroup: only?.status === 'already_member' ? { id: only.chatId, name: only.name } : null,
  }
}
