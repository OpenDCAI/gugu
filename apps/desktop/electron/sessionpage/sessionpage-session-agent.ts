// @@@sessionpage TASKPAGE-FUSION — 「这个会话页会话是哪个咕咕 agent」的唯一查法。
//
// 绑定的真相在本机 roster 记录的 cache 上(provisionSessionpageAgentForSession 写的
// emdash_session_id),不在会话页后端的库里 —— 平台额度、目录预选都要问同一个问题,所以
// 抽在这里一份,免得两处各写一遍再漂移。

import { localAgentForSession } from '../session/main/core/sessionpage/sessionpage-session-agent'

// 「会话 → agent」只有一份实现(会话页引擎那一侧,宿主与引擎都读它),这里转出去,❌ 宿主再抄一份。
export { guguAgentUserIdForSession, localAgentForSession } from '../session/main/core/sessionpage/sessionpage-session-agent'

/** 分叉要沿用的那一份来源身份 —— 只读解析,一格都不写。 */
export interface RuntimeForkSource {
  agentUserId: string
  /** 来源 agent 的显示名,进 IM 闸的报错文案。来源没名字时是空串,❌ 不编。 */
  forkOf: string
}

/**
 * 运行时分叉(侧边聊天)沿用来源会话的身份 —— 返回 null = 这不是分叉,或来源自己都没有身份。
 *
 * 为什么沿用而不是给一套精简的:系统提示与工具清单都在模型前缀里,分叉继承的是来源的
 * transcript,前缀只要有一处不同,那整段上下文就命中不了缓存。「没有身份」这条不靠削能力来
 * 表达,而是靠 IM 那道闸(gugu-im-server.mjs 的 dispatchTool)。
 *
 * ❌ 这里**不 provision**:归属仲裁会 unregister 掉来源会话正在用的 app-server(owner 实测当场
 * 打死主 codex 会话),绑定盖章会把来源的 surface 从 tui 改写成 acp。
 */
export async function resolveRuntimeForkSource(
  info: { sessionId: string; sourceSessionId?: string },
  env: NodeJS.ProcessEnv,
): Promise<RuntimeForkSource | null> {
  const source = info.sourceSessionId?.trim() ?? ''
  // 自己指向自己不是分叉 —— 普通会话也会把 sourceConversationId 填成自己。
  if (!source || source === info.sessionId) return null
  const agent = await localAgentForSession(source, env)
  if (!agent?.gugu_user_id) return null
  return {
    agentUserId: agent.gugu_user_id,
    forkOf: agent.name ?? '',
  }
}
