// @@@4526B 取消一个 agent **当前在飞的那一轮**。
//
// 为什么它存在:owner 能想到的「停下这个 agent」的动作就是删除它,UI 也确实回了 `Agent deleted`——
// 而实测里那一轮一路跑到 61.8s 正常回了 `DONE`,继续烧上游配额,产出写进一条用户已经看不见的会话,
// 中间没有任何一处告诉他真相。所以删除序在释放本机足迹之前先走这里。
//
// 为什么不复用「释放/teardown」那条路:那条路的契约是**有界等待在飞 turn 结算**(spec delivery-routing),
// 它服务的是「会话还要继续存在」的释放——等待是为了不丢掉一轮已经跑出来的结果。owner 删除恰恰相反:
// 那一轮的结果已经没有收件人,而删除本身就是「停下它」。⇒ 取消,不等待。
//
// 两条腿各问一次**它自己的** resolver,❌ 宿主不按 provider 名分支:
//   · 原生 TUI 腿 —— 问投递属主注册表「谁认领了这个 agent」(与 unregisterSessionpageDeliveryOwners 同一把钥匙);
//   · ACP 腿     —— 问 `emdashAgentRegistry`「这条会话此刻在不在生成」,由它按 host adapter 选通道。
//
// ⚠️ 本模块**只取消那一轮**。provider 进程该不该退出是另一件事(「一轮跑完就退出」与咕咕的中途投递
// 恰好相反 —— 会话得活着才能收下一条),当前未判定;父进程已死的孤儿 app-server 回收也是独立的问题。
import { createLogger } from '../lib/logger'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { isAgentActive } from '@gugu/core/shared/agentStatus'
import { agentStatusFeed } from './agent-status-feed'
import { sessionpageDeliveryTargets } from './sessionpage-delivery-owner-registry'
import type { SessionpageDeliveryTarget } from './session-injection'

export interface CancelAgentInFlightTurnDeps {
  /** 注入点只为单测;生产走两个真实注册表。 */
  deliveryTargets?: () => readonly SessionpageDeliveryTarget[]
  cancelSessionTurn?: (sessionId: string) => Promise<boolean>
  /** 「它此刻在不在干活」的事实源 —— 与产品显示 Working 用的是同一份(#4008)。 */
  isWorking?: (agentUserId: string) => boolean
}

/**
 * 取消该 agent 在飞的那一轮。
 *
 * 返回 `true` = 真的取消了一轮;`false` = **此刻本来就没有可取消的轮**(no-op,不是失败)。
 * 通道自己的失败原样上抛 —— owner 按了删除却没停下来,必须说出来,❌ 不许静默当成已停。
 */
export async function cancelAgentInFlightTurn(
  agentUserId: string,
  sessionId: string,
  deps: CancelAgentInFlightTurnDeps = {},
): Promise<boolean> {
  if (!agentUserId) throw new Error('cancelAgentInFlightTurn requires an agentUserId')
  // 取消的结果必须可读:一次"什么都没取消"的删除与一次"取消成功"的删除在 UI 上完全同形,
  // 而这张票的本体就是那个看不见的差别。所以选了哪条腿、结论是什么,都记一行。
  const log = createLogger('sessionpage/turn-cancel')
  const targets = (deps.deliveryTargets ?? sessionpageDeliveryTargets)()
  for (const target of targets) {
    // 认领判定与投递、注销用的是同一把钥匙(liveSessionIdByAgent),❌ 不另造一套"谁在跑"的推导。
    if (target.liveSessionIdByAgent(agentUserId) === null) continue
    if (!target.cancelTurn) {
      // 认领了却没接通取消 ⇒ 这条腿此刻停不下来。回报"已停下"会是假的,所以出声。
      throw new Error(
        `session-page delivery target ${target.deliveryTargetName ?? 'unknown'} claims agent ${agentUserId} `
          + 'but cannot cancel its in-flight turn — refusing to report the agent as stopped',
      )
    }
    const cancelled = await target.cancelTurn(agentUserId)
    log.info(
      { agentUserId, sessionId, leg: target.deliveryTargetName ?? 'unknown', cancelled },
      'owner delete: cancelled the in-flight turn through the claiming session-page delivery target',
    )
    return cancelled
  }
  if (!sessionId) {
    log.info({ agentUserId }, 'owner delete: no session-page session bound — nothing to cancel')
    return false
  }
  const cancelAcp = deps.cancelSessionTurn
    ?? ((id: string) => emdashAgentRegistry.cancelSessionTurn(id))
  const cancelled = await cancelAcp(sessionId)
  log.info(
    { agentUserId, sessionId, leg: 'sessionpage', cancelled },
    cancelled
      ? 'owner delete: cancelled the in-flight turn through the session-page channel'
      : 'owner delete: the session-page channel reported no turn to cancel',
  )
  if (cancelled) return true
  // ⚠️ 「没有通道认得这一轮」与「本来就没有这一轮」必须分开。产品自己(侧栏那个 Working)
  // 说它在干活,而我们一个通道都没取消掉 —— 那不是 no-op,是**没停下来**。
  // 静默返回 false 会让 UI 照样说 `Agent deleted`,正是这张票要修的那个形状。
  const working = (deps.isWorking ?? ((id: string) => isAgentActive(agentStatusFeed.get(id)?.reading ?? null)))(agentUserId)
  if (working) {
    throw new Error(
      `agent ${agentUserId} is still working on session-page session ${sessionId || '(unbound)'} `
        + 'but no control channel could cancel its in-flight turn — refusing to report the agent as stopped',
    )
  }
  return false
}
