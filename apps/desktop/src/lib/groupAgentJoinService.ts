import { i18n } from '@/i18n'
import { chatDb } from './supabase'
import { currentGroupAdmin } from './groupAdmin'
import {
  groupJoinDenialKey,
  latestAgentJoinRequestStatus,
  type AgentJoinRequestStatus,
  type GroupAgentJoinOutcome,
} from './groupAgentJoin'

export type { GroupAgentJoinOutcome }

/** 库里已知的入群拒绝用现有产品文案;其余保留拒绝方的原因。 */
export function groupJoinError(error: { message: string }): Error {
  const key = groupJoinDenialKey(error.message)
  return key
    ? new Error(i18n.t(key, { ns: 'messaging' }), { cause: error })
    : new Error(error.message, { cause: error })
}

/**
 * 新入群只走 add_group_agent RPC:「能否加此人」的判定只在库里一处(chat.group_add_denial),
 * ❌ 客户端直插 chat_members 另判一遍。群开了「Agent 加入需审批」而你不是管理员时,
 * 结果是 pending_approval —— 一条待审请求,不入群。
 */
export async function addGroupAgent(chatId: string, agentUserId: string, role: string): Promise<GroupAgentJoinOutcome> {
  const admin = await currentGroupAdmin()
  let result
  try { result = await admin.addAgent(chatId, agentUserId) } catch (error) { throw groupJoinError(error as Error) }
  if (result.status === 'pending_approval') return 'pending_approval'
  if (role !== 'member') {
    if (role !== 'admin') throw new Error('Invalid group role')
    await admin.setRole(chatId, agentUserId, role)
  }
  return 'joined'
}

/** 我替自己的 agent 发起过的入群请求(待审 / 已批准 / 已拒绝),每个 agent 取最近一条。 */
export async function listMyAgentJoinRequests(chatId: string): Promise<Map<string, AgentJoinRequestStatus>> {
  const { data, error } = await chatDb.rpc('list_my_agent_join_requests', { p_chat_id: chatId })
  if (error) throw new Error(error.message, { cause: error })
  return latestAgentJoinRequestStatus((data ?? []) as Array<{ agent_user_id: string; status: string }>)
}
