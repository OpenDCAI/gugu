import type { AgentType } from '../agentTypes'

// @@@owned-agent-rest - provision an agent identity owned by the current human via the identity-schema
export interface ProvisionOwnedAgentInput {
  supabaseUrl: string
  anonKey: string
  accessToken: string
  displayName: string
  /** 可空：没有上传头像时 canonical identity 持久化 null。 */
  avatar: string | null
  agentType: AgentType
  deviceId: string
  localPath?: string | null
  promptPath?: string | null
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export interface ProvisionedOwnedAgent {
  id: string
  displayName: string
  avatar: string | null
  createdAt: string | null
}

export async function provisionOwnedAgent(
  input: ProvisionOwnedAgentInput
): Promise<ProvisionedOwnedAgent> {
  const base = input.supabaseUrl.replace(/\/$/, '')
  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(`${base}/rest/v1/rpc/create_owned_agent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      apikey: input.anonKey,
      'Content-Type': 'application/json',
      'Content-Profile': 'identity',
      'Accept-Profile': 'identity',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      p_display_name: input.displayName,
      p_avatar: input.avatar,
      p_agent_type: input.agentType,
      p_device_id: input.deviceId,
      p_local_path: input.localPath ?? null,
      p_prompt_path: input.promptPath ?? null
    })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`create_owned_agent failed (${response.status}): ${detail}`)
  }
  const rows = (await response.json().catch(() => null)) as
    | Array<{ id: string; display_name: string; avatar: string | null; created_at: string | null }>
    | null
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) throw new Error('create_owned_agent returned no agent')
  return {
    id: row.id,
    displayName: row.display_name,
    avatar: row.avatar ?? null,
    createdAt: row.created_at ?? null
  }
}

// #5331 会话页会话启动:铸身份 + 名字唯一性 + 进项目群 = **一次**往返(identity.provision_taskpage_agent)。
// 老链是查名字面 → 铸身份 → 查群 → 加座位/建群四发串行;owner 机器上每发 0.44 s、冷连接 1.4 s。
export interface ProvisionSessionpageAgentOneTripInput {
  supabaseUrl: string
  anonKey: string
  accessToken: string
  /** 客户端预生成的身份 id:启动链可以在身份落地前就把它写进引擎启动参数。 */
  agentId: string
  /** 已对本机名册去过重的候选名;云端那一半的去重在服务端做。 */
  displayName: string
  /**
   * serial =「<label> <n>」自增约定:服务端从 max(这个账号该前缀用过的最大号 + 1, n) 起号并原子占号(#6396 只增不减),
   *          再跳过此刻被占的名字;
   * explicit = 保名 —— 起会话方显式给的名字,或本机早已发出去、云端这次才补登记的名字;此刻被占 ⇒ 同样从
   *            这个前缀的账本往上占号(「Claude 29」被占 ⇒ 下一个没用过的 Claude 号;「小弟」被占 ⇒ 小弟 2、3 …)。
   */
  nameMode: 'serial' | 'explicit'
  agentType: AgentType
  deviceId: string
  localPath?: string | null
  /** 有项目才给:群名(= 项目名)。null ⇒ 不碰任何群。 */
  groupName?: string | null
  /** 映射里记着的项目群 id('' / null = 没有)。服务端核它还在不在、归档没有。 */
  priorGroupChatId?: string | null
  /** 要建新群时用的 id(客户端预生成,建没建看返回值)。 */
  newGroupChatId?: string | null
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export interface ProvisionedSessionpageAgentOneTrip {
  agentId: string
  /** 服务端最终定下的名字(云端撞名时会与候选名不同)。 */
  displayName: string
  /** '' = 无项目 / 没进群。 */
  groupChatId: string
  groupCreated: boolean
  /**
   * none | active | archived | missing | foreign —— 映射里那个群在服务端看来的状态。
   * foreign = 那个 id 不是调用者所在的群(别人的群 / 非群);服务端不往里加人,改建新群(同 archived)。
   * pending_approval = 群开了「Agent 加入需审批」而调用者不是管理员:进了待审请求,groupChatId 为 ''。
   * join_failed:<denial or SQLSTATE> = 入群失败,身份仍已创建,groupChatId 为 ''。
   */
  priorGroupState: string
}

export async function provisionSessionpageAgentOneTrip(
  input: ProvisionSessionpageAgentOneTripInput
): Promise<ProvisionedSessionpageAgentOneTrip> {
  const base = input.supabaseUrl.replace(/\/$/, '')
  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(`${base}/rest/v1/rpc/provision_taskpage_agent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      apikey: input.anonKey,
      'Content-Type': 'application/json',
      'Content-Profile': 'identity',
      'Accept-Profile': 'identity',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      p_agent_id: input.agentId,
      p_display_name: input.displayName,
      p_name_mode: input.nameMode,
      p_agent_type: input.agentType,
      p_device_id: input.deviceId,
      p_local_path: input.localPath ?? null,
      p_group_chat_id: input.priorGroupChatId || null,
      p_new_group_id: input.newGroupChatId || null,
      p_group_name: input.groupName ?? null
    })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`provision_taskpage_agent failed (${response.status}): ${detail}`)
  }
  const rows = (await response.json().catch(() => null)) as
    | Array<{ agent_id: string; display_name: string; group_chat_id: string | null; group_created: boolean; prior_group_state: string }>
    | null
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.agent_id) throw new Error('provision_taskpage_agent returned no agent')
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    groupChatId: row.group_chat_id ?? '',
    groupCreated: Boolean(row.group_created),
    priorGroupState: row.prior_group_state ?? 'none'
  }
}
