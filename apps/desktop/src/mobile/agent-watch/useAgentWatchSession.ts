import * as sessionpageRpc from './sessionpage-rpc'
import { useTimelineSession, type AgentWatchSession } from './use-timeline-session'

export type { AgentWatchPhase, AgentWatchSession } from './use-timeline-session'

/**
 * 回答者标识,进 `Settlement.resolvedBy`,只用于显示「已在某端回答」。
 * 手机是遥控端,答复作用在那台机器上的会话 —— 这里不是设备 id,它表达的是「哪一端答的」。
 */
export const MOBILE_RESPONDER_ID = 'mobile'

/** 手机打开一台在线机器上的一条会话;同步逻辑见 use-timeline-session(与桌面会话页同一份)。 */
export function useAgentWatchSession(
  deviceId: string | null,
  sessionId: string | null,
  enabled: boolean,
  firstPrompt?: string,
): AgentWatchSession {
  return useTimelineSession(sessionpageRpc, MOBILE_RESPONDER_ID, deviceId, sessionId, enabled, firstPrompt)
}
