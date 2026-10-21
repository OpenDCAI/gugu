// sidecar 终端腿(codex app-server、opencode / mimocode serve)从引擎自己的事件流读出的回合事实,经
// `onTurnLifecycle` 交给宿主,原样翻成 `AgentEvent`;状态只由 agent-status-writer 的日志产出。
import type { AgentEvent, AgentWaitKind } from '../../src/session/shared/core/agents/agentEvents'

/**
 * 一条边。`stop` 带 `outcome: 'cancelled'` = 用户打断;`error` 带 `signInRequired` = 这一轮被「这台机器上的登录不能用了」
 * 拒掉(#6264,宿主据此回写「登录已失效」);`wait` / `wait_resolved` 用引擎自己的 `waitId` 配对。
 */
export type TurnLifecycleEdge =
  | { type: 'start' }
  | { type: 'stop'; outcome?: 'cancelled' }
  | { type: 'error'; signInRequired?: boolean }
  | { type: 'wait'; waitKind: AgentWaitKind; waitId: string }
  | { type: 'wait_resolved'; waitId: string }

/** 这条边让回合结束了吗 —— 平台凭据的回合末恢复只跟它走;停下等人不是回合末。 */
export function edgeEndsTurn(edge: TurnLifecycleEdge): boolean {
  return edge.type === 'stop' || edge.type === 'error'
}

export interface TurnLifecycleTarget {
  sessionId: string
  providerId: string
  projectId: string
}

/** 宿主那一侧的唯一翻法:一条边 → 一条 `AgentEvent`(`source:'hook'`、无 `sourceId`:它不是 CLI hook 送来的)。 */
export function relayTurnLifecycleEvent(
  edge: TurnLifecycleEdge,
  target: TurnLifecycleTarget,
  timestamp: number,
): AgentEvent {
  const payload: AgentEvent['payload'] = {}
  if (edge.type === 'stop' && edge.outcome) payload.outcome = edge.outcome
  if (edge.type === 'error' && edge.signInRequired) payload.signInRequired = true
  if (edge.type === 'wait') {
    payload.waitKind = edge.waitKind
    payload.waitId = edge.waitId
  }
  if (edge.type === 'wait_resolved') payload.waitId = edge.waitId
  return {
    type: edge.type,
    providerId: target.providerId,
    projectId: target.projectId,
    sessionId: target.sessionId,
    timestamp,
    payload,
  }
}
