import {describe,expect,it,vi} from 'vitest'
import {createConnectionClient} from '@gugu/core/cloud/connections'
import {createOwnerConnectionStore,ownerConnectionResourceKey} from '../../apps/desktop/src/components/connections/owner-connection-store'
import type {ConnectionMetadataItem,ConnectionMetadataSnapshot} from '../../apps/desktop/src/components/connections/connection-metadata'

const account = (deviceId: string | null): ConnectionMetadataItem => {
  const scopeKey=deviceId ? `device:${deviceId}` : 'platform',resourceKey='["amap","default"]'
  return {owner_user_id:'owner',domain:'integrations',resource_key:ownerConnectionResourceKey(scopeKey,resourceKey),
    source:{scopeKey,resourceKey},device_id:deviceId,revision:'3',data:{providerId:'amap',accountId:'default',configured:true},
    body_item_id:null,body_sha256:null,deleted_at:null,observed_at:null,updated_at:'2026-11-07T00:00:00Z'}
}
function setup(row: ConnectionMetadataItem) {
  let cached: ConnectionMetadataSnapshot={version:1,revision:'3',items:[row],application:[]}
  const transport=vi.fn(async (_name: string,args: Record<string,unknown>)=>({data:{operationId:args.p_operation_id,
    revision:'4',status:'pending',scopeKey:args.p_scope_key,resourceKey:args.p_resource_key},error:null}))
  const execute=vi.fn(async (_operationId: string)=>{})
  const store=createOwnerConnectionStore({ownerId:'owner',deviceId:'selected-desktop',accountId:()=> 'owner',
    client:createConnectionClient(transport,()=> 'owner'),cache:{peek:()=>cached,save:value=>{cached=value}},changed:vi.fn(),executePlatformOperation:execute})
  return {store,transport,execute,cache:()=>cached}
}
describe('owner metadata mutation scope',()=>{
  it('keeps platform revocation independent of the desktop selected in settings',async()=>{
    const row=account(null),{store,transport,execute}=setup(row)
    await store.change(row,'remove')
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_commit',expect.objectContaining({p_scope_key:'platform',p_device_id:null}))
    expect(execute).toHaveBeenCalledExactlyOnceWith(transport.mock.calls[0]![1].p_operation_id)
  })
  it('retains the original UUID and tombstone when the platform service is unavailable',async()=>{
    const row=account(null),{store,transport,execute,cache}=setup(row),unavailable=new Error('SERVICE_UNAVAILABLE')
    execute.mockRejectedValueOnce(unavailable)
    await expect(store.change(row,'remove')).rejects.toBe(unavailable)
    expect(transport).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledExactlyOnceWith(transport.mock.calls[0]![1].p_operation_id)
    expect(cache().items[0]).toMatchObject({revision:'4',data:{configured:false}})
    expect(cache().items[0]!.deleted_at).toBeTruthy()
  })
  it('keeps a device mutation on its original device rather than the selected desktop',async()=>{
    const row=account('original-device'),{store,transport,execute}=setup(row)
    await store.change(row,'remove')
    expect(transport).toHaveBeenCalledExactlyOnceWith('connection_commit',expect.objectContaining({p_scope_key:'device:original-device',p_device_id:'original-device'}))
    expect(execute).not.toHaveBeenCalled()
  })
})
