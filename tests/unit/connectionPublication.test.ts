import { describe,expect,it,vi } from 'vitest'
import { publishConnectionObservations, type ConnectionObservation } from '../../apps/desktop/electron/sessionpage/connection-publication'
import { createConnectionClient,type ConnectionItem,type ConnectionSnapshot } from '../../packages/core/src/cloud/connections'
const row = (): ConnectionItem => ({ scopeKey: 'device:device',resourceKey: 'imported-key',deviceId: 'device',revision: '6',data: { providerId: 'github',accountId: 'one',configured: true },
  publicMetadata: null,document: null,bodySha256: null,deletedAt: null,staleAt: null,observedAt: null,updatedAt: '2026-11-07T00:00:00Z' })
const snapshot = (items: ConnectionItem[]): ConnectionSnapshot => ({ version: 1,state: 'ready',revision: '7',items,application: [] })
const observed = (): ConnectionObservation => ({ scopeKey: 'device:device',deviceId: 'device',data: row().data,document: '{"providerId":"github","accountId":"one"}' })
function setup() {
  const rpc = vi.fn(async (_name: string,args: Record<string,unknown>) => ({ data: { operationId: args.p_operation_id,revision: '8',status: 'applied',scopeKey: args.p_scope_key,resourceKey: args.p_resource_key },error: null }))
  const publish = (value: ConnectionSnapshot,observations = [observed()]) => publishConnectionObservations({ snapshot: value,observations,
    client: createConnectionClient(rpc,() => 'owner'),runtimeInstanceId: 'runtime' })
  return { rpc,publish }
}
describe('owner observations', () => {
  it('retains imported identity and uses item CAS plus the actual runtime', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([row()]))
    expect(rpc).toHaveBeenCalledExactlyOnceWith('connection_commit',expect.objectContaining({ p_resource_key: 'imported-key',p_expected_revision: '6',p_runtime_instance_id: 'runtime',p_recreation_id: null }))
  })
  it('never republishes a tombstone or treats a missing local account as a remove', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([{ ...row(),deletedAt: '2026-11-07T00:00:00Z' }]))
    await publish(snapshot([row()]),[])
    expect(rpc).not.toHaveBeenCalled()
  })
  it('keeps another device with an equal provider/account separate on first observation', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([{ ...row(),scopeKey: 'device:other',deviceId: 'other' }]))
    expect(rpc).toHaveBeenCalledWith('connection_commit',expect.objectContaining({ p_scope_key: 'device:device',p_expected_revision: '0',p_device_id: 'device' }))
  })
  it('refuses an ambiguous mapping rather than choosing or rebuilding a resource key', async () => {
    const { rpc,publish } = setup()
    await expect(publish(snapshot([row(),{ ...row(),resourceKey: 'second-key' }]))).rejects.toMatchObject({ code: 'ambiguous-resource' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
