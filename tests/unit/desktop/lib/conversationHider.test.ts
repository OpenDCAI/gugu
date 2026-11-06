import { describe, expect, it, vi } from 'vitest'
import { createConversationHider } from '../../../../apps/desktop/src/lib/conversationHider'
const receipt = { chat_id: 'chat', hidden_at: '2026-11-06T17:00:00Z', operation_id: 'op1', account_revision: '9007199254740993' }
function fixture() {
  const boundary = new AbortController()
  const hide = vi.fn().mockResolvedValue(receipt), confirm = vi.fn().mockResolvedValue(undefined)
  const operationId = vi.fn().mockReturnValueOnce('op1').mockReturnValueOnce('op2')
  return { boundary, hide, confirm, operationId, run: createConversationHider({ hide, confirm, operationId, boundary: () => boundary.signal }) }
}
describe('shared store hide controller', () => {
  it('retains an uncertain operation ID through a transport retry', async () => {
    const f = fixture()
    f.hide.mockRejectedValueOnce(new Error('network'))
    await expect(f.run('owner', 'chat')).rejects.toThrow('network')
    await f.run('owner', 'chat')
    expect(f.hide.mock.calls).toEqual([['chat', 'op1'], ['chat', 'op1']])
    expect(f.confirm).toHaveBeenCalledWith('owner', receipt)
    await f.run('owner', 'chat')
    expect(f.hide).toHaveBeenLastCalledWith('chat', 'op2')
  })
  it('retries only reconciliation after an acknowledged hide, so restored rows cannot be hidden again', async () => {
    const f = fixture()
    f.confirm.mockRejectedValueOnce(new Error('local storage'))
    await expect(f.run('owner', 'chat')).rejects.toThrow('local storage')
    await f.run('owner', 'chat')
    expect(f.hide).toHaveBeenCalledTimes(1)
    expect(f.confirm).toHaveBeenCalledTimes(2)
  })
  it('coalesces simultaneous submissions and ignores a receipt after signout', async () => {
    const f = fixture()
    let resolve!: (value: typeof receipt) => void
    f.hide.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const a = f.run('owner', 'chat'), b = f.run('owner', 'chat')
    expect(a).toBe(b)
    f.boundary.abort(); resolve(receipt)
    await a
    expect(f.hide).toHaveBeenCalledTimes(1)
    expect(f.confirm).not.toHaveBeenCalled()
  })
})
