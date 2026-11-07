import { describe,expect,it,vi } from 'vitest'
import { createConnectionClient } from '../../packages/core/src/cloud/connections'
import { createConnectionAuthorization } from '../../apps/desktop/src/components/connections/connection-authorization'

const recreationId = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
function setup() {
  let owner = 'owner',items: unknown[] = []
  const rpc = vi.fn(async (name: string,args: Record<string,unknown>): Promise<{ data: unknown; error: null }> => {
    if (name === 'connection_snapshot') return { data: { version: 1,state: 'ready',revision: '7',items,application: [] },error: null }
    if (name === 'connection_recreate_begin') return { data: { recreationId,operationId: args.p_operation_id,expectedItemRevision: args.p_expected_revision,revision: '7',expiresAt: '2026-11-07T00:00:00Z' },error: null }
    if (name === 'connection_commit') return { data: { operationId: args.p_operation_id,revision: '8',status: 'applied',scopeKey: args.p_scope_key,resourceKey: args.p_resource_key ?? 'service-resolved-key' },error: null }
    if (name === 'connection_commit_batch') return { data: { operationId: args.p_operation_id,revision: '8',receipts: (args.p_operations as { operationId: string }[]).map((row,i) => ({ operationId: row.operationId,revision: '8',status: 'applied',scopeKey: 'device:device',resourceKey: `key-${i}` })) },error: null }
    throw new Error(`Unexpected ${name}`)
  })
  const authorization = createConnectionAuthorization({ client: createConnectionClient(rpc,() => owner),accountId: () => owner,changed: vi.fn() })
  return { authorization,rpc,items(value: unknown[]) { items = value },switchOwner() { owner = 'other' } }
}
const account = (id = 'actual-account') => ({ data: { providerId: 'github',accountId: id,configured: true },publicMetadata: { version: 1,providerId: 'github',accountId: id,login: 'person' } })

describe('explicit owner authorization intent', () => {
  it('obtains a provider/head ticket before the service returns an unknown account key', async () => {
    const { authorization,rpc } = setup()
    const intent = await authorization.begin('github','device:device','device')
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['connection_snapshot','connection_recreate_begin'])
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_resource_key: null,p_expected_revision: null,p_provider_id: 'github',p_expected_head_revision: '7' })
    const value = account()
    expect((await authorization.complete(intent,value.data,value.publicMetadata)).resourceKey).toBe('service-resolved-key')
    expect(rpc).toHaveBeenLastCalledWith('connection_commit',expect.objectContaining({ p_operation_id: intent.operationId,p_recreation_id: recreationId,
      p_resource_key: null,p_expected_revision: null,p_runtime_instance_id: null }))
  })
  it('retains an imported tombstone key and its exact revision for known-account recreation', async () => {
    const { authorization,rpc,items } = setup()
    items([{ scopeKey: 'device:device',resourceKey: 'original-imported-key',deviceId: 'device',revision: '6',data: account().data,publicMetadata: null,
      document: null,bodySha256: null,deletedAt: '2026-11-07T00:00:00Z',staleAt: null,observedAt: null,updatedAt: '2026-11-07T00:00:00Z' }])
    const intent = await authorization.begin('github','device:device','device','actual-account')
    const value = account()
    await authorization.complete(intent,value.data,value.publicMetadata)
    expect(rpc).toHaveBeenLastCalledWith('connection_commit',expect.objectContaining({ p_resource_key: 'original-imported-key',p_expected_revision: '6' }))
  })
  it('does not consume the ticket for another provider/account or after an owner switch', async () => {
    const { authorization,rpc,switchOwner } = setup()
    const intent = await authorization.begin('github','device:device','device','known')
    const value = account()
    await expect(authorization.complete(intent,value.data,value.publicMetadata)).rejects.toMatchObject({ code: 'identity-changed' })
    switchOwner()
    await expect(authorization.complete(intent,value.data,value.publicMetadata)).rejects.toMatchObject({ code: 'account-changed' })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('surfaces a changed intent without minting a replacement ticket or changing the UUID', async () => {
    const { authorization,rpc } = setup()
    const intent = await authorization.begin('github','device:device','device')
    rpc.mockRejectedValueOnce(new Error('HEAD_CHANGED'))
    const value = account()
    await expect(authorization.complete(intent,value.data,value.publicMetadata)).rejects.toMatchObject({ code: 'transport-failed' })
    await authorization.complete(intent,value.data,value.publicMetadata)
    const commits = rpc.mock.calls.filter(([name]) => name === 'connection_commit')
    expect(commits[0]).toEqual(commits[1])
    expect(rpc.mock.calls.filter(([name]) => name === 'connection_recreate_begin')).toHaveLength(1)
  })
  it('retains every child UUID when retrying a batch after losing its response', async () => {
    const { authorization,rpc } = setup()
    const intent = await authorization.begin('github','device:device','device')
    rpc.mockRejectedValueOnce(new Error('RESPONSE_LOST'))
    const values = [account('one'),account('two')]
    await expect(authorization.completeBatch(intent,values)).rejects.toMatchObject({ code: 'transport-failed' })
    await authorization.completeBatch(intent,values)
    const calls = rpc.mock.calls.filter(([name]) => name === 'connection_commit_batch')
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]![1].p_operation_id).toBe(intent.operationId)
    await expect(authorization.completeBatch(intent,[account('different')])).rejects.toMatchObject({ code: 'identity-changed' })
  })
})
