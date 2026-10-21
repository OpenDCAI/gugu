import type { LocalAgentRecord } from './agents'

// #5331 会话启动不等云端:名册行(内网身份)先写,公网身份(identity.users 那一行)在后台铸。
// 这中间有一段真空 —— 行已经在本机存在、云端还没有它。这个格子就是那段真空的名字:
// 'pending' = 公网那一发在飞;'failed' = 重试完还是没铸出来,下次重开再试;'ready' = 已落地。
export const AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY = 'sessionpage_cloud_identity_state'

export function agentCloudIdentityState(
  record: Pick<LocalAgentRecord, 'cache'> | null | undefined
): string {
  const value = record?.cache?.[AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY]
  return typeof value === 'string' ? value : ''
}

/**
 * 公网身份还没落地 ⇒ 这一行**还没有**云端对应物,而不是「云端那一行没了」。
 *
 * 判据要这么写的原因(真机复现):runtime-state 的写会命中 migration 036 `can_write_agent_runtime_state`
 * 的 RAISE,#2151 的 gone-agent 守卫据此把名册行当成「别处删了」静默摘掉。在本地优先铸身份之前
 * 这个推断永远成立;之后不再成立 —— 新起的会话有整整几百毫秒处在这段真空里,守卫会把一条**正在
 * 用**的行删掉,随后公网那一发回写名字就报 `Agent 'gugu_user_id=…' does not exist`,会话卡死。
 */
export function agentCloudIdentityPending(
  record: Pick<LocalAgentRecord, 'cache'> | null | undefined
): boolean {
  return agentCloudIdentityState(record) === 'pending'
}
