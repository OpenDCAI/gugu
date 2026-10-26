import { describe, expect, it, vi } from 'vitest'
import { createAssistantPanelOutbox } from '../../packages/core/src/cloud/assistantPanelOutbox'

const notice = (operationId = 'edit') => ({ operationId,resource: 'devices',operation: 'edited' as const,id: 'device' })
function fixture() {
  const values = new Map<string, string>()
  let owner = 'owner'
  const send = vi.fn(async (_assistant: string, change: ReturnType<typeof notice>) => ({ operationId: change.operationId,revision: '1',status: 'pending' as const }))
  const deps = { storage: { getItem: (key: string) => values.get(key) ?? null,setItem: (key: string, value: string) => { values.set(key,value) } },
    accountId: () => owner,assistantId: vi.fn(async () => 'assistant'),send }
  return { deps,values,send,switchOwner: (next: string) => { owner = next } }
}

describe('saved App change outbox', () => {
  it('persists before publication and retries the same ID after restart without contacting a device', async () => {
    const world = fixture()
    world.send.mockRejectedValueOnce(new Error('Offline'))
    const outbox = createAssistantPanelOutbox(world.deps)
    await expect(outbox.enqueue('owner',notice())).rejects.toThrow('Offline')
    expect(outbox.hasPending('owner')).toBe(true)
    await createAssistantPanelOutbox(world.deps).flush('owner')
    expect(outbox.hasPending('owner')).toBe(false)
    expect(world.send.mock.calls.map(call => call[1].operationId)).toEqual(['edit','edit'])
  })

  it('preserves an enqueue made while an earlier send is in flight', async () => {
    const world = fixture()
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    world.send.mockImplementationOnce(async (_assistant, change) => { await waiting; return { operationId: change.operationId,revision: '1',status: 'pending' } })
    const outbox = createAssistantPanelOutbox(world.deps)
    const first = outbox.enqueue('owner',notice('first'),'assistant')
    const second = outbox.enqueue('owner',notice('second'),'assistant')
    finish()
    await Promise.all([first,second])
    expect(world.send.mock.calls.map(call => call[1].operationId)).toEqual(['first','second'])
    expect(outbox.hasPending('owner')).toBe(false)
  })

  it('leaves another account out of publication and does not discard the first account queue', async () => {
    const world = fixture()
    world.deps.assistantId.mockImplementationOnce(async () => { world.switchOwner('other'); return 'assistant' })
    const outbox = createAssistantPanelOutbox(world.deps)
    await expect(outbox.enqueue('owner',notice())).rejects.toMatchObject({ code: 'account-changed' })
    expect(world.send).not.toHaveBeenCalled()
    world.switchOwner('owner')
    expect(outbox.hasPending('owner')).toBe(true)
    await outbox.flush('owner')
    expect(world.send).toHaveBeenCalledTimes(1)
  })

  it('rejects damaged persisted data and reused IDs instead of silently dropping changes', async () => {
    const world = fixture()
    world.send.mockRejectedValue(new Error('Offline'))
    const outbox = createAssistantPanelOutbox(world.deps)
    await expect(outbox.enqueue('owner',notice())).rejects.toThrow('Offline')
    expect(() => outbox.enqueue('owner',{ ...notice(),id: 'different' })).toThrow('different content')
    world.values.set('gugu.assistant-panel.notices.v1:owner','{}')
    expect(() => outbox.hasPending('owner')).toThrow('could not be read')
  })
})
