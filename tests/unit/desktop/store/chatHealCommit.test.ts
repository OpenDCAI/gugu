/**
 * R6 — 补洞结果被新快照(epoch)取代时不许静默丢弃:会话仍在屏上 ⇒ 失败,让修订派发重补。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitHealedMessages, SupersededHealError } from '../../../../apps/desktop/src/store/chatHealCommit'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionSource } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'

afterEach(() => vi.useRealTimers())

describe('commitHealedMessages (R6)', () => {
  it('落窗成功 ⇒ 不报错', () => {
    expect(() => commitHealedMessages({ chatId: 'c', apply: () => true, stillActive: () => true })).not.toThrow()
  })
  it('被新快照拒收且会话仍在屏上 ⇒ 抛 SupersededHealError', () => {
    expect(() => commitHealedMessages({ chatId: 'c', apply: () => false, stillActive: () => true })).toThrow(SupersededHealError)
  })
  it('被拒收但会话已切走 ⇒ 不补(重新打开会冷拉)', () => {
    expect(() => commitHealedMessages({ chatId: 'c', apply: () => false, stillActive: () => false })).not.toThrow()
  })

  it('接进修订派发:补洞被取代时这条 message_created 不被确认,退避后重补并落窗', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction((tx) => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    const syncSince = vi.fn<AccountRevisionSource['syncSince']>()
      .mockResolvedValueOnce({ operations: [{ revision: '1', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: 'm-9' } }], hasMore: false })
      .mockResolvedValue({ operations: [], hasMore: false })
    const coordinator = createAccountRevisionCoordinator('account-a', repository, {
      syncSince,
      subscribeWake: (_id, _onWake, onSubscribed) => { onSubscribed(); return () => undefined },
    })
    let epoch = 0
    const applied: number[] = []
    // 第一次补洞在途时发生了删除(epoch +1),取回的行被拒收
    const heal = vi.fn(async () => {
      const started = epoch
      epoch += heal.mock.calls.length === 1 ? 1 : 0
      commitHealedMessages({
        chatId: 'chat-1',
        apply: () => { if (started !== epoch) return false; applied.push(9); return true },
        stillActive: () => true,
      })
    })
    coordinator.subscribe('message_created', heal)
    coordinator.start()
    await coordinator.whenIdle().catch(() => undefined)
    expect(applied).toEqual([])
    expect(repository.snapshot().view, '被取代的补洞不确认 operation').toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    await coordinator.whenIdle()
    expect(heal).toHaveBeenCalledTimes(2)
    expect(applied).toEqual([9])
    expect(repository.snapshot().view).toEqual([])
    coordinator.stop()
  })
})
