/**
 * 把 agent 拉进群的结果与拒绝原因(库里 chat.add_group_agent / decide_group_join 的稳定 ASCII 标识)。
 *
 * 「Agent 加入需审批」开着、操作者又不是管理员时,结果是 pending_approval —— 一条待审请求,
 * 由群主/管理员在通讯录「新的请求 → 群聊」里批准或拒绝(#6418)。这是正常结果,不是故障:界面说「已提交审批」,
 * ❌ 不把数据库原文贴给用户。
 */
export type GroupAgentJoinOutcome = 'joined' | 'pending_approval'

/** 库里抛的拒绝标识 → messaging 命名空间里的文案 key。认不出的返回 null(交给通用失败文案)。 */
const DENIAL_KEYS: Record<string, string> = {
  member_limit_reached: 'group.join.denied.memberLimit',
  cloud_agent: 'chatService.errors.cloudAgentGroupUnsupported',
  agent_not_owned: 'group.join.denied.agentNotOwned',
  actor_not_member: 'group.join.denied.notMember',
  group_archived: 'group.join.denied.groupArchived',
  not_a_group: 'group.join.denied.groupArchived',
  join_request_requester_left: 'group.join.denied.requesterLeft',
  join_request_agent_owner_left: 'group.join.denied.agentOwnerLeft',
  'Join request already decided': 'group.join.denied.alreadyDecided',
}

export function groupJoinDenialKey(message: string | null | undefined): string | null {
  if (!message) return null
  for (const [code, key] of Object.entries(DENIAL_KEYS)) {
    if (message.includes(code)) return key
  }
  return null
}

export function parseGroupAgentJoinOutcome(data: unknown): GroupAgentJoinOutcome {
  const status = (data as { status?: unknown } | null)?.status
  if (status === 'joined' || status === 'pending_approval') return status
  throw new Error(`add_group_agent returned an unexpected status: ${JSON.stringify(status)}`)
}

export type AgentJoinRequestStatus = 'pending' | 'accepted' | 'rejected'

/** 发起人自己那头每个 agent 最近一条请求的状态(RPC 已按 updated_at 倒序)。 */
export function latestAgentJoinRequestStatus(
  rows: ReadonlyArray<{ agent_user_id: string; status: string }>,
): Map<string, AgentJoinRequestStatus> {
  const latest = new Map<string, AgentJoinRequestStatus>()
  for (const row of rows) {
    if (latest.has(row.agent_user_id)) continue
    if (row.status === 'pending' || row.status === 'accepted' || row.status === 'rejected') latest.set(row.agent_user_id, row.status)
  }
  return latest
}

/** 一次批量添加的结果汇总:已入群、已提交审批、失败。 */
export function summarizeAgentJoinResults(
  results: ReadonlyArray<PromiseSettledResult<GroupAgentJoinOutcome | void>>,
): { joined: number; pendingApproval: number; failed: number } {
  let joined = 0
  let pendingApproval = 0
  let failed = 0
  for (const result of results) {
    if (result.status === 'rejected') failed += 1
    else if (result.value === 'pending_approval') pendingApproval += 1
    else joined += 1
  }
  return { joined, pendingApproval, failed }
}

/** 待审请求要显示的身份:申请人(人或 agent),以及 agent 请求里替它发起的人。 */
export function joinRequestIdentityIds(rows: ReadonlyArray<{ requester_user_id: string; requested_by_user_id?: string | null }>): string[] {
  return [...new Set(rows.flatMap((row) => (row.requested_by_user_id ? [row.requester_user_id, row.requested_by_user_id] : [row.requester_user_id])))]
}
