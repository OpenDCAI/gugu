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
  const snapshot={version:1,state:'ready',revision:'3',items:[{scopeKey:row.source!.scopeKey,resourceKey:row.source!.resourceKey,deviceId:row.device_id,revision:row.revision,data:row.data,publicMetadata:null,document:null,bodySha256:null,deletedAt:row.deleted_at,staleAt:null,observedAt:null,updatedAt:row.updated_at}],application:[] as unknown[]}
  const transport=vi.fn(async (name: string,args: Record<string,unknown>)=> name==='connection_snapshot' ? {data:snapshot,error:null} : {data:{operationId:args.p_operation_id,
    revision:'4',status:'pending',scopeKey:args.p_scope_key,resourceKey:args.p_resource_key},error:null})
  const execute=vi.fn(async (_operationId: string)=>{})
  const store=createOwnerConnectionStore({ownerId:'owner',deviceId:'selected-desktop',accountId:()=> 'owner',
    client:createConnectionClient(transport,()=> 'owner'),cache:{peek:()=>cached,save:value=>{cached=value}},changed:vi.fn(),executePlatformOperation:execute})
  return {store,transport,execute,snapshot,commit:()=>transport.mock.calls.find(call=>call[0]==='connection_commit')!,cache:()=>cached}
}
describe('owner metadata mutation scope',()=>{
  it('keeps platform revocation independent of the desktop selected in settings',async()=>{
    const row=account(null),{store,execute,commit}=setup(row)
    await store.change(row,'remove')
    expect(commit()).toEqual(['connection_commit',expect.objectContaining({p_scope_key:'platform',p_device_id:null})])
    expect(execute).toHaveBeenCalledExactlyOnceWith(commit()[1].p_operation_id)
  })
  it('retains the original UUID and tombstone when the platform service is unavailable',async()=>{
    const row=account(null),{store,transport,execute,cache,commit}=setup(row),unavailable=new Error('SERVICE_UNAVAILABLE')
    execute.mockRejectedValueOnce(unavailable)
    await expect(store.change(row,'remove')).rejects.toBe(unavailable)
    expect(transport.mock.calls.filter(call=>call[0]==='connection_commit')).toHaveLength(1)
    expect(execute).toHaveBeenCalledExactlyOnceWith(commit()[1].p_operation_id)
    expect(cache().items[0]).toMatchObject({revision:'4',data:{configured:false}})
    expect(cache().items[0]!.deleted_at).toBeTruthy()
  })
  it('keeps a device mutation on its original device rather than the selected desktop',async()=>{
    const row=account('original-device'),{store,execute,commit}=setup(row)
    await store.change(row,'remove')
    expect(commit()).toEqual(['connection_commit',expect.objectContaining({p_scope_key:'device:original-device',p_device_id:'original-device'})])
    expect(execute).not.toHaveBeenCalled()
  })
})

it.each(['remove','default'] as const)('blocks a retained account %s confirmation after its application becomes UNKNOWN',async operation=>{
  const row=account(null),{store,transport,execute,snapshot}=setup(row)
  snapshot.application=[{operationId:'6c67af58-7190-4c6f-9d49-06d0f6f4865f',requestHash:'a'.repeat(64),scopeKey:row.source!.scopeKey,resourceKey:row.source!.resourceKey,deviceId:null,
    revision:'3',expectedItemRevision:'2',operation:'save',status:'failed',errorCode:'CONNECTION_OUTCOME_UNKNOWN',terminal:true,admissionId:null,startedAt:null}]
  const result=operation==='remove' ? store.change(row,'remove') : store.save(row,{providerId:'amap',accountId:'default',isDefault:true})
  await expect(result).rejects.toMatchObject({code:'outcome-unknown'})
  expect(transport.mock.calls.filter(call=>call[0]==='connection_commit')).toHaveLength(0)
  expect(execute).not.toHaveBeenCalled()
})
