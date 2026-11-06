import { describe,it,expect,vi } from 'vitest'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
function setup() {
  let owner = 'owner',value: ConnectionRoute = { mode: 'legacy',epoch: '1',phase: 'stable',acceptingNewOperations: true }
  const read = vi.fn(async () => value),changed = vi.fn()
  const routing = createConnectionRouting({ accountId: () => owner,read,changed })
  return { routing,read,changed,mode(next: Pick<ConnectionRoute,'mode' | 'epoch'> & Partial<ConnectionRoute>) { value = { phase: 'stable',acceptingNewOperations: true,...next } },account(next: string) { owner = next } }
}
describe('explicit connection authority routing', () => {
  it('uses only the original path in legacy mode, even when owner APIs are closed', async () => {
    const { routing } = setup(),legacy = vi.fn(async () => 'existing'),owner = vi.fn(async () => { throw Object.assign(new Error('CLOSED'),{ code: '42501' }) })
    expect(await routing.run({ legacy,owner })).toBe('existing')
    expect(legacy).toHaveBeenCalledOnce(); expect(owner).not.toHaveBeenCalled()
  })
  it('never guesses a fallback for 42501 or a failed routing read', async () => {
    const { routing,read,mode } = setup(),legacy = vi.fn(async () => 'legacy'),owner = vi.fn(async () => { throw Object.assign(new Error('CLOSED'),{ code: '42501' }) })
    mode({ mode: 'owner',epoch: '2' })
    await expect(routing.run({ legacy,owner })).rejects.toMatchObject({ code: '42501' })
    read.mockRejectedValueOnce(new Error('NETWORK'))
    await expect(routing.run({ legacy,owner })).rejects.toThrow('NETWORK')
    expect(legacy).not.toHaveBeenCalled(); expect(owner).toHaveBeenCalledOnce()
  })
  it('refuses a late legacy result after cutover without starting owner work or replaying its effect', async () => {
    const { routing,mode } = setup(),owner = vi.fn(async () => 'owner')
    const legacy = vi.fn(async () => { mode({ mode: 'owner',epoch: '2' }); return 'late-success' })
    await expect(routing.run({ legacy,owner })).rejects.toMatchObject({ code: 'route-changed' })
    expect(legacy).toHaveBeenCalledOnce(); expect(owner).not.toHaveBeenCalled()
  })
  it('binds routes to owner and epoch and rejects an inconsistent or older routing result', async () => {
    const { routing,mode,account } = setup()
    const first = await routing.capture()
    account('other')
    expect(routing.peek()).toBeUndefined()
    await expect(first.assertCurrent()).rejects.toMatchObject({ code: 'account-changed' })
    account('owner'); mode({ mode: 'owner',epoch: '1' })
    await expect(routing.read()).rejects.toMatchObject({ code: 'invalid-response' })
    mode({ mode: 'owner',epoch: '2' }); await routing.read(); mode({ mode: 'legacy',epoch: '1' })
    await expect(routing.read()).rejects.toMatchObject({ code: 'route-changed' })
  })
  it('starts no authorization or effect while the server is quiescing', async () => {
    const { routing,mode } = setup(),legacy = vi.fn(async () => 'legacy'),owner = vi.fn(async () => 'owner')
    mode({ mode: 'legacy',epoch: '1',phase: 'quiescing',acceptingNewOperations: false })
    await expect(routing.run({ legacy,owner })).rejects.toMatchObject({ code: 'quiescing' })
    expect(legacy).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled()
  })
})
