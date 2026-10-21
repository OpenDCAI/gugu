// @@@2504 TASKPAGE-FUSION — 「在任务中打开」需要的那一步解析:一个 gugu agent → 它在会话页里的坐标
// (project / 会话)。数据不是新开的:会话页每起一个会话,emdash-agent-provisioning 就把这
// 两个 id 记在该 agent 的 roster 记录 cache 上;这里只是把它读回来。
//
// owner 拍板(#2504 spec 讨论):**按钮按解析结果渲染** —— 解析得到才显示「在任务中打开」,解析不到就
// 不渲染这个入口。所以 null 是正常返回值,不是错误:
//   · 跨设备创建的 agent —— 它的会话行和 roster 都在**那台**机器上,本机查不到;
//   · 存量的对话页出身 agent(走 gugu 原生 ACP 那条)—— 它根本没有会话页会话。
// 这两类落在 null 分支是预期行为。❌ 不 throw、❌ 不造错误态、❌ 不猜 —— 给它们造一个「点了报错」的
// 按钮，比不渲染更糟。
//
// 与 sessionpage-agent-card 的分工:那边回答「这条会话是哪个 agent」(分享名片,按会话 id 查);这边回答
// 「这个 agent 在会话页的哪儿」(按 agentUserId 查),方向相反,共用同一份 roster cache。
import { listAgents } from '@gugu/core'
import {
  SESSION_CACHE_KEY,
  IMPLICIT_SESSION_HOME_PROJECT_ID,
  PROJECT_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'

/** 会话页里能直接打开的一处坐标 —— 正好是 openSessionInSessionWhenReady 要的两件。 */
export interface SessionpageOpenTarget {
  projectId: string
  sessionId: string
}

/** roster 记录里本解析用到的那一小片(便于测试传入,不必造整条记录)。 */
export interface SessionpageMappingCandidate {
  gugu_user_id?: string | null
  cache?: Record<string, unknown> | null
}

/**
 * 纯解析:从 roster 里找出该 agent 的会话页坐标。不做 IO —— roster 由调用方给。
 *
 * 两个 id 必须同时在:少任何一个都打不开一处确定的会话,宁可不渲染入口,也不要打开半个。
 */
export function resolveSessionpageOpenTarget(
  agents: readonly SessionpageMappingCandidate[],
  guguAgentUserId: string,
): SessionpageOpenTarget | null {
  const wanted = guguAgentUserId.trim()
  if (!wanted) return null

  for (const agent of agents) {
    if ((agent.gugu_user_id ?? '') !== wanted) continue
    const projectId = cacheString(agent.cache, PROJECT_CACHE_KEY)
    const sessionId = cacheString(agent.cache, SESSION_CACHE_KEY)
    if (!agent.cache || !Object.hasOwn(agent.cache, PROJECT_CACHE_KEY) || !sessionId) {
      return null
    }
    return {
      projectId: projectId || IMPLICIT_SESSION_HOME_PROJECT_ID,
      sessionId,
    }
  }
  return null
}

/** 上面那个的 IO 外壳:读本机 roster 再解析。与 resolveSessionpageAgentCard 同款形状。 */
export async function readSessionpageOpenTarget(
  guguAgentUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionpageOpenTarget | null> {
  const wanted = guguAgentUserId.trim()
  if (!wanted) return null
  const roster = await listAgents(env, { includeGuests: true })
  return resolveSessionpageOpenTarget(roster, wanted)
}
