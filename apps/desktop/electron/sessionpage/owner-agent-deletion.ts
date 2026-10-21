// @@@4526 owner 亲手删除一个 agent 之后,本机这一侧要按什么顺序做什么。
//
// 为什么单独成一个模块:这段编排**曾经只活在 main.ts 的 IPC handler 里**,于是它没有任何单测,
// 四门全绿的情况下我把它改坏过一次 —— 一次「取消没接通」的抛错让足迹释放压根没跑到,
// B 的缺陷把 A 的缺陷(孤儿 + 复活)整个带了回来。而那次回归**只有手跑真 Electron 才看得见**
// (那条 e2e 按 `electron-gui` 豁免,不在任何 CI job 的执行集里)。
// ⇒ 编排本身必须是可单测的纯函数式接线,让这一类回归落回四门。
//
// 两条不变量,顺序与耦合各管一件事:
//   ① **先停止,后抹除**。反过来的话,那一轮会在一个已经查不到绑定的会话上继续跑,
//      连「它还在跑」都没人看得见。
//   ② **取消失败不中止释放**。云端身份此刻**已经删了**(联系人已经从通讯录消失,那是云端 RPC
//      造成的,与本机这半无关);此时若因为「停不下来」而跳过清理,用户得到的是两个缺陷叠加:
//      既没停下来,本机还全留着。⇒ 尽力停 → 无论如何清干净 → 最后如实报「没停下来」。
import { releaseAgentLocalFootprint, sessionpageSessionIdForAgent } from './agent-local-footprint'
import type { ReleasedAgentLocalFootprint } from './agent-local-footprint'
import { cancelAgentInFlightTurn } from './agent-turn-cancel'

export interface OwnerAgentDeletionDeps {
  /** 注入点只为单测;生产走真实实现。 */
  sessionIdForAgent?: (agentUserId: string) => Promise<string>
  cancelInFlightTurn?: (agentUserId: string, sessionId: string) => Promise<boolean>
  releaseFootprint?: (agentUserId: string) => Promise<ReleasedAgentLocalFootprint>
  env?: NodeJS.ProcessEnv
}

export interface OwnerAgentDeletionResult extends ReleasedAgentLocalFootprint {
  cancelledTurn: boolean
}

/**
 * 释放一个 owner 刚删掉的 agent 在本机的一切:先取消它在飞的回合,再释放本机足迹。
 *
 * 取消失败时:**足迹照常释放完**,然后把取消失败原样抛出去 —— 调用方(渲染层)据此
 * 不显示「已删除」。❌ 不吞:没停下来却回报已删除,正是这张票的形状本身。
 */
export async function releaseDeletedOwnedAgent(
  agentUserId: string,
  deps: OwnerAgentDeletionDeps = {},
): Promise<OwnerAgentDeletionResult> {
  const env = deps.env ?? process.env
  const sessionIdFor = deps.sessionIdForAgent
    ?? ((id: string) => sessionpageSessionIdForAgent(id, env))
  const cancel = deps.cancelInFlightTurn ?? cancelAgentInFlightTurn
  const release = deps.releaseFootprint
    ?? ((id: string) => releaseAgentLocalFootprint({ agentUserId: id, identityRemoved: true, env }))

  const sessionId = await sessionIdFor(agentUserId)

  let cancelledTurn = false
  let cancelFailure: Error | null = null
  try {
    cancelledTurn = await cancel(agentUserId, sessionId)
  } catch (error) {
    cancelFailure = error as Error
  }

  const released = await release(agentUserId)
  if (cancelFailure) throw cancelFailure
  return { ...released, cancelledTurn }
}
