import { describe, expect, it, vi } from 'vitest'
import { releaseDeletedOwnedAgent } from '../../../../apps/desktop/electron/sessionpage/owner-agent-deletion'

// #4526 —— owner 删除后本机这一侧的编排。这组用例存在的理由本身就是一条读数:
//
// 这段编排原先只活在 main.ts 的 IPC handler 里,**没有任何单测**。我在做 B 的时候把它改坏了:
// 「取消没接通」的 fail-loud 直接抛,于是足迹释放压根没跑到 —— B 的缺陷把 A 的缺陷(孤儿 + 复活)
// 整个带了回来。**四门全绿**,因为唯一能看见它的是那条真 Electron e2e,而那条按 `electron-gui`
// 豁免、不在任何 CI job 的执行集里。⇒ 一个能判假、但没人会跑的判据,等于没有。
//
// 所以把编排抽成可注入的纯接线,让这一类回归落回四门。

const footprint = { rosterRemoved: true, sessionId: 'conv-1', name: 'Codex 5' }
const removeBoundSession = vi.fn(async (_sessionId: string) => {})

describe('#4526 owner 删除:先停止、后抹除,且停不下来不得中止抹除', () => {
  it('顺序是硬的:取消发生在释放足迹之前', async () => {
    const calls: string[] = []
    await releaseDeletedOwnedAgent('agent-1', {
      sessionIdForAgent: async () => 'conv-1',
      cancelInFlightTurn: async () => { calls.push('cancel'); return true },
      releaseFootprint: async () => { calls.push('release'); return footprint },
      removeBoundSession: async () => { calls.push('delete-task') },
    })
    // 反过来的话,那一轮会在一个已经查不到绑定的会话上继续跑,连"它还在跑"都没人看得见。
    expect(calls).toEqual(['cancel', 'release', 'delete-task'])
  })

  it('取消**失败**时:足迹照样释放完,然后把失败如实抛出去', async () => {
    const release = vi.fn(async () => footprint)
    const failure = new Error('claims agent but cannot cancel its in-flight turn')
    const removeTask = vi.fn(async (_id: string) => {})

    await expect(
      releaseDeletedOwnedAgent('agent-1', {
        sessionIdForAgent: async () => 'conv-1',
        cancelInFlightTurn: async () => { throw failure },
        releaseFootprint: release,
        removeBoundSession: removeTask,
      }),
      '停不下来要如实报出去 —— 否则 UI 会继续说 Agent deleted',
    ).rejects.toThrow(/cannot cancel its in-flight turn/)

    // 这一条就是那次回归的判据:云端身份此刻**已经删了**,若因为"停不下来"跳过清理,
    // 用户拿到的是两个缺陷叠加 —— 既没停下来,本机还全留着(孤儿 + 复活)。
    expect(release, '取消失败 ❌ 不得中止足迹释放').toHaveBeenCalledWith('agent-1')
    expect(removeTask).toHaveBeenCalledExactlyOnceWith('conv-1')
  })

  it('取消是 no-op(本来就没有在飞的轮)时,照常释放并如实报 cancelledTurn=false', async () => {
    const result = await releaseDeletedOwnedAgent('agent-1', {
      sessionIdForAgent: async () => 'conv-1',
      cancelInFlightTurn: async () => false,
      releaseFootprint: async () => footprint,
      removeBoundSession,
    })
    expect(result).toEqual({ ...footprint, cancelledTurn: false })
  })

  it('取消成功时 cancelledTurn=true,并带上足迹释放的结果', async () => {
    const result = await releaseDeletedOwnedAgent('agent-1', {
      sessionIdForAgent: async () => 'conv-1',
      cancelInFlightTurn: async () => true,
      releaseFootprint: async () => footprint,
      removeBoundSession,
    })
    expect(result).toEqual({ ...footprint, cancelledTurn: true })
  })

  it('取消拿到的是这个 agent 绑定的那条会话,不是别的', async () => {
    const cancel = vi.fn(async () => true)
    await releaseDeletedOwnedAgent('agent-1', {
      sessionIdForAgent: async () => 'conv-xyz',
      cancelInFlightTurn: cancel,
      releaseFootprint: async () => footprint,
      removeBoundSession,
    })
    expect(cancel).toHaveBeenCalledWith('agent-1', 'conv-xyz')
  })
})
