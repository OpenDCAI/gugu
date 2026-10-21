import { describe, expect, it, vi } from 'vitest'
import { cancelAgentInFlightTurn } from '../../../../apps/desktop/electron/sessionpage/agent-turn-cancel'
import type { SessionpageDeliveryTarget } from '../../../../apps/desktop/electron/sessionpage/session-injection'

// #4526 缺陷 B —— owner 删除一个**正忙**的 agent 时,那一轮必须被取消。
//
// 实测读数:删除动作发生时 `sleep 45` 那个任务仍在跑,它一路跑到 61.8s 正常回了 `DONE` ——
// identity 已经从 identity.users 删掉了,而它的 harness 还在正常干活、还在正常产出。
// 删除是用户唯一能想到的「停下它」的动作,UI 还明确回了 `Agent deleted`。
//
// 本组用例钉住这条路由的三件事:认领者优先、空闲不造假、以及**认领了却停不下来时必须出声**。
// ⚠️ 每条都带阳性对照(先证明这条腿确实被认领了 / 确实有轮在飞),否则"没取消"是一句空话。

function target(overrides: Partial<SessionpageDeliveryTarget> & { name: string }): SessionpageDeliveryTarget {
  return {
    deliveryTargetName: overrides.name,
    liveSessionIdByAgent: () => null,
    ...overrides,
  } as unknown as SessionpageDeliveryTarget
}

describe('#4526B 删除一个正忙的 agent ⇒ 先取消它在飞的那一轮', () => {
  it('原生 TUI 腿:认领了这个 agent 的 target 负责取消,ACP 腿不再被问', async () => {
    const cancelTurn = vi.fn(async () => true)
    const cancelSessionTurn = vi.fn(async () => true)
    const claiming = target({ name: 'codex-app-server', liveSessionIdByAgent: () => 'thread-1', cancelTurn })

    // 阳性对照:这条腿确实认领了它(否则下面断言的是一条永远为真的空话)。
    expect(claiming.liveSessionIdByAgent('agent-1'), '阳控:TUI 腿认领了这个 agent').toBe('thread-1')

    const cancelled = await cancelAgentInFlightTurn('agent-1', 'conv-1', {
      deliveryTargets: () => [claiming],
      cancelSessionTurn,
    })

    expect(cancelled).toBe(true)
    expect(cancelTurn).toHaveBeenCalledWith('agent-1')
    expect(cancelSessionTurn, '认领者已经处理了 ⇒ ❌ 不再去 ACP 腿上重取消一次').not.toHaveBeenCalled()
  })

  it('没有认领者 ⇒ 落到 ACP 腿,由 conversation 键控 resolver 选通道', async () => {
    const cancelSessionTurn = vi.fn(async () => true)
    const unrelated = target({ name: 'other', liveSessionIdByAgent: () => null, cancelTurn: vi.fn(async () => true) })

    const cancelled = await cancelAgentInFlightTurn('agent-1', 'conv-1', {
      deliveryTargets: () => [unrelated],
      cancelSessionTurn,
    })

    expect(cancelled).toBe(true)
    expect(cancelSessionTurn).toHaveBeenCalledWith('conv-1')
    expect(unrelated.cancelTurn, '❌ 没认领这个 agent 的 target 不该被问').not.toHaveBeenCalled()
  })

  it('空闲(没有在飞的轮)⇒ 返回 false,不构造一次假取消', async () => {
    // 通道说"此刻没有可取消的轮" —— 那是 no-op,不是失败,也不能被读成"取消成功"。
    const cancelTurn = vi.fn(async () => false)
    const claiming = target({ name: 'codex-app-server', liveSessionIdByAgent: () => 'thread-1', cancelTurn })

    const cancelled = await cancelAgentInFlightTurn('agent-1', 'conv-1', {
      deliveryTargets: () => [claiming],
      cancelSessionTurn: async () => true,
    })

    expect(cancelTurn, '阳控:通道确实被问过了(不是压根没走到)').toHaveBeenCalledWith('agent-1')
    expect(cancelled, '空闲时如实报 false —— ❌ 不把 no-op 说成已取消').toBe(false)
  })

  it('认领了这个 agent 却没接通取消 ⇒ fail loud,❌ 不静默当成"已经停了"', async () => {
    const claiming = target({ name: 'legacy-leg', liveSessionIdByAgent: () => 'thread-1' })
    const cancelSessionTurn = vi.fn(async () => true)

    await expect(
      cancelAgentInFlightTurn('agent-1', 'conv-1', {
        deliveryTargets: () => [claiming],
        cancelSessionTurn,
      }),
      '停不下来就要出声:回报"已停下"会是假的',
    ).rejects.toThrow(/cannot cancel its in-flight turn/)

    expect(
      cancelSessionTurn,
      '❌ 也不许"这条腿不行就悄悄换另一条腿" —— 那会把一次未取消伪装成成功',
    ).not.toHaveBeenCalled()
  })

  it('产品说它在干活、却没有任何通道取消得掉 ⇒ fail loud,❌ 不静默返回"没什么可取消的"', async () => {
    // 这是真机撞出来的形状:原生 TUI 腿在 ACP 的会话清单里查不到,早先的实现据此静默返回 false;
    // 侧栏明明显示 Working,删除却回报"没什么可取消的",UI 照样说 Agent deleted。
    // 「没有通道认得这一轮」与「本来就没有这一轮」必须分开。
    const cancelled = await cancelAgentInFlightTurn('agent-1', 'conv-1', {
      deliveryTargets: () => [],
      cancelSessionTurn: async () => false,
      isWorking: () => false,
    })
    expect(cancelled, '阳控:同样的通道结果 + 不在干活 ⇒ 如实 no-op(证明下面的红不是恒红)').toBe(false)

    await expect(
      cancelAgentInFlightTurn('agent-1', 'conv-1', {
        deliveryTargets: () => [],
        cancelSessionTurn: async () => false,
        isWorking: () => true,
      }),
      '它在干活而没人停得下它 —— 那不是 no-op,是没停下来',
    ).rejects.toThrow(/no control channel could cancel its in-flight turn/)
  })

  it('没有会话绑定、也没有认领者 ⇒ 无事可取消,返回 false', async () => {
    const cancelSessionTurn = vi.fn(async () => true)
    const cancelled = await cancelAgentInFlightTurn('agent-1', '', {
      deliveryTargets: () => [],
      cancelSessionTurn,
    })
    expect(cancelled).toBe(false)
    expect(cancelSessionTurn, '没有 conversation 就没有可问的通道').not.toHaveBeenCalled()
  })
})
