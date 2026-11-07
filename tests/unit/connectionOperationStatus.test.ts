import {describe,it,expect,vi} from 'vitest'
import {createConnectionClient} from '@gugu/core/cloud/connections'
import {parseConnectionOperationStatus} from '@gugu/core/cloud/connectionOperationStatus'
import {createPlatformIntegrationsClient} from '@gugu/core/cloud/platformIntegrations'
const operationId='10000000-0000-4000-8000-000000000001'
const status=()=>({version:1,operationId,scopeKey:'platform',resourceKey:null,deviceId:null,revision:null,operation:'save',
 original:{status:'pending',errorCode:null,terminal:false},resolution:null,
 effective:{state:'confirming',connectionState:'confirming',blocksNewOperations:true},confirmation:{state:'pending',deadlineAt:null}})
describe('public operation result boundary',()=>{
 it('reads native or platform status through the named owner RPC without a runtime, service or guessed resource',async()=>{
  const transport=vi.fn(async()=>({data:{...status(),scopeKey:'device:one',deviceId:'one',evidence:'private'},error:null}))
  const client=createConnectionClient(transport,()=> 'owner')
  expect(await client.operationStatus(operationId)).toEqual({...status(),scopeKey:'device:one',deviceId:'one'})
  expect(transport).toHaveBeenCalledExactlyOnceWith('connection_operation_status',{p_operation_id:operationId})
 })
 it('retains a missing status as unknown data and never converts a permission error to another source',async()=>{
  const missing=createConnectionClient(async()=>({data:null,error:null}),()=> 'owner')
  expect(await missing.operationStatus(operationId)).toBeNull()
  const transport=vi.fn(async()=>({data:null,error:{code:'42501',message:'CLOSED'}}))
  await expect(createConnectionClient(transport,()=> 'owner').operationStatus(operationId)).rejects.toMatchObject({code:'42501'})
  expect(transport).toHaveBeenCalledOnce()
 })
 it('projects only public fields, retaining nullable pre-publication identity',()=>{
  const value={...status(),credentialGeneration:'private-generation',evidence:{private:true}}
  const parsed=parseConnectionOperationStatus(value,operationId)
  expect(parsed.resourceKey).toBeNull();expect(parsed.revision).toBeNull();expect(JSON.stringify(parsed)).not.toContain('private')
 })
 it('retains original UNKNOWN while accepting an independent successful resolution',()=>{
  const value={...status(),original:{status:'failed',errorCode:'CONNECTION_OUTCOME_UNKNOWN',terminal:true},
   resolution:{outcome:'applied',resolvedAt:'2026-11-07T00:00:00Z',errorCode:null},effective:{state:'succeeded',connectionState:'connected',blocksNewOperations:false}}
  const parsed=parseConnectionOperationStatus(value,operationId)
  expect(parsed.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN');expect(parsed.effective.blocksNewOperations).toBe(false)
 })
 it('rejects another UUID, arbitrary error details and inconsistent unblock flags',()=>{
  expect(()=>parseConnectionOperationStatus({...status(),operationId:'other'},operationId)).toThrow()
  expect(()=>parseConnectionOperationStatus({...status(),original:{status:'failed',errorCode:'private-database-error',terminal:true}},operationId)).toThrow()
  expect(()=>parseConnectionOperationStatus({...status(),effective:{state:'confirming',connectionState:'confirming',blocksNewOperations:false}},operationId)).toThrow()
  expect(()=>parseConnectionOperationStatus({...status(),original:{status:'failed',errorCode:'CONNECTION_OUTCOME_UNKNOWN',terminal:true},
   effective:{state:'succeeded',connectionState:'connected',blocksNewOperations:false}},operationId)).toThrow()
 })
 it('reads status with GET and no body, never the deletion or authorization endpoint',async()=>{
  const fetcher=vi.fn(async()=>Response.json(status()))
  const client=createPlatformIntegrationsClient({baseUrl:'https://fixture.invalid',accessToken:async()=> 'fixture-token',fetch:fetcher})
  expect(await client.operationStatus!(operationId)).toEqual(status())
  const [url,request]=fetcher.mock.calls[0]! as unknown as [string,RequestInit]
  expect(url).toBe(`https://fixture.invalid/integrations/operations/${operationId}`);expect(request.method).toBe('GET');expect(request.body).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
 })
 it('submits the original UUID/epoch and preserves a confirming authorization receipt',async()=>{
  const fetcher=vi.fn(async()=>Response.json({operationId,state:'confirming'},{status:202}))
  const client=createPlatformIntegrationsClient({baseUrl:'https://fixture.invalid',accessToken:async()=> 'fixture-token',fetch:fetcher})
  expect(await client.connectOperation!('amap',operationId,'4',{apiKey:'fixture-key'})).toEqual({operationId,state:'confirming'})
  const [url,request]=fetcher.mock.calls[0]! as unknown as [string,RequestInit]
  expect(url).toBe('https://fixture.invalid/integrations/amap/connect-operation')
  expect(JSON.parse(request.body as string)).toEqual({operationId,epoch:'4',fields:{apiKey:'fixture-key'}})
 })
})

it('cancels only the original owner UUID and preserves a silent independent cancellation result',async()=>{
 const value={...status(),resolution:{outcome:'cancelled',resolvedAt:'2026-11-07T00:00:00Z',errorCode:null},
  effective:{state:'cancelled',connectionState:'disconnected',blocksNewOperations:false},confirmation:{state:'resolved',deadlineAt:null,cancelRequested:true}}
 const fetcher=vi.fn(async()=>Response.json(value)),client=createPlatformIntegrationsClient({baseUrl:'https://fixture.invalid',accessToken:async()=> 'fixture-token',fetch:fetcher})
 expect(await client.cancelOperation!(operationId)).toEqual(value)
 const [url,request]=fetcher.mock.calls[0]! as unknown as [string,RequestInit]
 expect(url).toBe(`https://fixture.invalid/integrations/operations/${operationId}/cancel`);expect(request.method).toBe('POST');expect(request.body).toBeUndefined()
 const transport=vi.fn(async()=>({data:value,error:null})),community=createConnectionClient(transport,()=> 'owner')
 expect(await community.cancelAuthorization(operationId)).toEqual(value)
 expect(transport).toHaveBeenCalledExactlyOnceWith('connection_authorization_cancel',{p_operation_id:operationId})
})
it('does not treat UNKNOWN or a mismatched cancellation projection as a settled result',()=>{
 const v={...status(),original:{status:'failed',errorCode:'CONNECTION_OUTCOME_UNKNOWN',terminal:true},effective:{state:'succeeded',connectionState:'connected',blocksNewOperations:false}}
 expect(()=>parseConnectionOperationStatus(v,operationId)).toThrow()
 expect(()=>parseConnectionOperationStatus({...status(),resolution:{outcome:'cancelled',resolvedAt:'2026-11-07T00:00:00Z',errorCode:null}},operationId)).toThrow()
})
