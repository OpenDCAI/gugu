// Local runtime and delivery cleanup is shared by explicit identity removal, provisional
// identity withdrawal and automatic archival. Only confirmed cloud removal records a tombstone.
import {
  archiveAgents,
  listAgents,
  recordReapedAgents,
  removeAgentRuntimeSession,
  removeAgents,
} from '@gugu/core'
import {
  SESSION_CACHE_KEY,
  OWNER_CACHE_KEY,
  PARKED_SESSION_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { unregisterLocalSessionDeliveryForAgent } from './local-session-delivery'

/**
 * @@@4526B 这个 agent 绑定的会话页会话 id(没有绑定 → '')。取消在飞回合要先知道取消**哪条会话**,
 * 而这层「agent → conversation」绑定就存在花名册记录的 cache 里 —— 与本模块读的是同一处,
 * ❌ 不在调用方再抄一遍 roster 读法。
 */
export async function sessionpageSessionIdForAgent(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!agentUserId) return ''
  const roster = await listAgents(env, { includeGuests: true })
  const record = roster.find((agent) => agent.gugu_user_id === agentUserId)
  return cacheString(record?.cache, SESSION_CACHE_KEY)
}

export interface ReleaseAgentLocalFootprintInput {
  agentUserId: string
  /** 墓碑上的展示名。留空时从花名册记录取——删除提示要说得出「谁」被删了。 */
  name?: string
  /** Confirmed cloud removal deletes the binding; automatic cleanup archives it. */
  identityRemoved: boolean
  env?: NodeJS.ProcessEnv
}

export interface ReleasedAgentLocalFootprint {
  /** 本轮真的摘掉了花名册记录吗(false = 本来就没有,幂等重放)。 */
  rosterRemoved: boolean
  /** 该 agent 绑定的会话页会话 id;没有绑定时为 ''。 */
  sessionId: string
  name: string
}

/**
 * 释放本机运行态和投递足迹;确认删除才摘名册并立碑,自动清理则归档并保留绑定。
 *
 * Fail-loud:任何一步抛出都原样上抛。本机足迹没释放干净却回报成功,正是这张票里
 * 「UI 说 Agent deleted、东西还在」的那个形状。
 */
export async function releaseAgentLocalFootprint(
  input: ReleaseAgentLocalFootprintInput,
): Promise<ReleasedAgentLocalFootprint> {
  const env = input.env ?? process.env
  const agentUserId = input.agentUserId?.trim()
  if (!agentUserId) throw new Error('releaseAgentLocalFootprint requires an agentUserId')

  // 会话绑定要在摘记录**之前**读出来:记录一删,这条绑定就再也查不到了,而墓碑要靠它拒绝重新开户。
  const roster = await listAgents(env, { includeGuests: true })
  const record = roster.find((agent) => agent.gugu_user_id === agentUserId)
  // #4277 停放行的绑定在 parked 格;它的墓碑同样要按会话记账,否则那个账号回来会重新开户。
  const sessionId = cacheString(record?.cache, SESSION_CACHE_KEY)
    || cacheString(record?.cache, PARKED_SESSION_CACHE_KEY)
  const ownerUserId = cacheString(record?.cache, OWNER_CACHE_KEY)
  const name = input.name?.trim() || record?.name || ''

  // ① 停止路由。registry 是进程内的投递地图,先摘它,后面的删文件/删记录才不会与一次在飞的投递交错。
  emdashAgentRegistry.unregister(agentUserId)

  // ② runtime session —— 本机运行态文件。纯机器状态,没有用户内容,直接删。
  await removeAgentRuntimeSession(agentUserId, env)

  // ③ 已确认永久删除才摘行;自动清理复用同一归档写口,保留原绑定。
  const removed = await (input.identityRemoved ? removeAgents : archiveAgents)((agent) => agent.gugu_user_id === agentUserId, env)

  // ④ 云端身份确认删除 + 花名册已摘 = 永久不可达 ⇒ 立碑。碑同时按 conversation id 记账,
  //    让那条仍然活着的会话页会话此后按 identity-none 处理,而不是被重新开户。
  if (input.identityRemoved && record) {
    await recordReapedAgents(
      [{
        gugu_user_id: agentUserId,
        name,
        reaped_at: new Date().toISOString(),
        ...(sessionId ? { conversation_id: sessionId } : {}),
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      }],
      env,
    )
  }

  unregisterLocalSessionDeliveryForAgent(agentUserId, sessionId || undefined)
  return { rosterRemoved: input.identityRemoved && removed.length > 0, sessionId, name }
}
