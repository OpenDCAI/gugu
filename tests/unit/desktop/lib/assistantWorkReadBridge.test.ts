// @vitest-environment jsdom
import {expect,it,vi} from 'vitest'
import type {Session} from '@supabase/supabase-js'
import {isAssistantPanelReadRetryable} from '@gugu/core/cloud/assistantPanelRead'
const wire=vi.hoisted(()=>({rpc:vi.fn(),listen:vi.fn()}))
vi.mock('../../../../apps/desktop/src/lib/supabase',()=>({identityDb:{rpc:wire.rpc}}))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel',()=>({subscribePrivateUserEventBus:wire.listen,unsubscribePrivateUserEventBus:()=>{}}))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore',()=>({getAgentPresenceSnapshot:()=>({reading:{status:'working'}}),subscribeAgentPresence:()=>()=>{}}))
vi.mock('../../../../apps/desktop/src/platform',()=>({platform:{subscribeAppForeground:()=>()=>{}}}))
it('a second bundle reads through the authenticated shell while its own session publication is empty',async()=>{
 const shellSession=await import('../../../../apps/desktop/src/lib/sessionPublication')
 shellSession.publishRendererSession('SIGNED_IN',{user:{id:'owner'}} as Session)
 wire.rpc.mockImplementation(()=>({abortSignal:async()=>({data:{items:[],next_before:null},error:null})}))
 const shell=await import('../../../../apps/desktop/src/lib/assistantWorkShell')
 const panel=await import('../../../../apps/desktop/src/lib/assistantPanelBridge')
 const target=window as import('../../../../apps/desktop/src/lib/assistantPanelBridge').AssistantPanelWindow
 target.__GUGU_ASSISTANT_PANEL__={work:shell.assistantWorkReads,accountId:()=>shellSession.getRendererSession()?.user.id??null,
  files:()=>{throw new Error('Unexpected file access')},personalAssistant:vi.fn(),privateChat:vi.fn(),queueNotice:vi.fn(),
  subscribeAccount:listener=>shellSession.observeRendererSession(()=>listener()),subscribeChanges:(owner,listener)=>{
   wire.listen(owner,'assistant_work_changed',listener,{});return ()=>{}
  }} as import('../../../../apps/desktop/src/lib/assistantPanelBridge').AssistantPanelBridge
 expect(panel.assistantPanelAccountId()).toBe('owner')
 const close=()=>{delete target.__GUGU_ASSISTANT_PANEL__}
 try{
  expect((window as Window&{__GUGU_ASSISTANT_PANEL__?:unknown}).__GUGU_ASSISTANT_PANEL__).toBeDefined()
  vi.resetModules()
  const otherSession=await import('../../../../apps/desktop/src/lib/sessionPublication')
  const reader=await import('../../../../apps/desktop/src/lib/assistantWork')
  expect(otherSession.getRendererSession()).toBeNull()
  expect(await reader.assistantWorkCloud.listAll('assistant')).toEqual([])
  expect(wire.rpc).toHaveBeenCalledWith('assistant_work_list',expect.objectContaining({p_assistant:'assistant'}))
  const bridge=await import('../../../../apps/desktop/src/lib/assistantWorkReadBridge')
  expect(bridge.assistantWorkPresence('agent')?.reading).toMatchObject({status:'working'})
  const stop=reader.watchAssistantWork('owner','assistant',vi.fn());stop()
  expect(wire.listen).toHaveBeenCalledWith('owner','assistant_work_changed',expect.any(Function),expect.any(Object))
  shellSession.publishRendererSession('SIGNED_OUT',null)
  await expect(reader.assistantWorkCloud.listAll('assistant')).rejects.toMatchObject({code:'signed-out'})
 }finally{close();shellSession.publishRendererSession('SIGNED_OUT',null)}
})

it.each(['list','history'])('bounds a stalled account %s read even if the transport never settles after cancellation',async kind=>{
 vi.useFakeTimers();vi.resetModules()
 const session=await import('../../../../apps/desktop/src/lib/sessionPublication')
 session.publishRendererSession('SIGNED_IN',{user:{id:'owner'}} as Session)
 const signals:AbortSignal[]=[]
 wire.rpc.mockImplementation(()=>({abortSignal:(signal:AbortSignal)=>{
  signals.push(signal);return new Promise(()=>{})
 }}))
 try{
  const shell=await import('../../../../apps/desktop/src/lib/assistantWorkShell')
  const failure=vi.fn()
  const flight=kind==='list'?shell.assistantWorkReads.client.listAll('assistant')
   :shell.assistantWorkReads.client.historyAll('assistant','10000000-0000-4000-8000-000000000001')
  void flight.catch(failure)
  await vi.advanceTimersByTimeAsync(15_001)
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({code:'read-timeout'}))
  expect(signals[0]?.aborted).toBe(true)
 }finally{session.publishRendererSession('SIGNED_OUT',null);vi.useRealTimers()}
})

it.each([{status:503,code:'PGRST000',retry:true},{status:0,code:'ENOTFOUND',retry:true},{status:403,code:'42501',retry:false},{status:500,code:'54000',retry:false}])('retains transport retryability for RPC status $status without retrying fixed errors',async value=>{
 vi.resetModules()
 const session=await import('../../../../apps/desktop/src/lib/sessionPublication')
 session.publishRendererSession('SIGNED_IN',{user:{id:'owner'}} as Session)
 wire.rpc.mockImplementation(()=>({abortSignal:async()=>({data:null,error:{code:value.code,message:'private transport detail'},status:value.status})}))
 try{
  const shell=await import('../../../../apps/desktop/src/lib/assistantWorkShell')
  const error=await shell.assistantWorkReads.client.listAll('assistant').catch(failure=>failure as unknown)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({code:value.code})
  if(value.status===0||value.status>=500)expect(error).toMatchObject({status:value.status})
  expect(isAssistantPanelReadRetryable(error)).toBe(value.retry)
 }finally{session.publishRendererSession('SIGNED_OUT',null)}
})

it('keeps one read deadline across task-list pages',async()=>{
 vi.useFakeTimers();vi.resetModules()
 const session=await import('../../../../apps/desktop/src/lib/sessionPublication')
 session.publishRendererSession('SIGNED_IN',{user:{id:'owner'}} as Session)
 const signals:AbortSignal[]=[]
 const row={owner_user_id:'owner',assistant_user_id:'assistant',work_id:'10000000-0000-4000-8000-000000000001',
  title:'A task',created_seq:'2',terminal_version:'0',coordinator_session_id:'main',coordinator_device_id:'home',
  executors:[{session_id:'worker',device_id:'phone'}],source_link:null,outcome:'active',executor_outcomes:{},
  created_at:'2026-10-26T00:00:00Z',updated_at:'2026-10-26T00:00:00Z'}
 wire.rpc.mockImplementation(()=>({abortSignal:(signal:AbortSignal)=>{
  signals.push(signal)
  return signals.length===1?new Promise(resolve=>setTimeout(()=>resolve({data:{items:[row],next_before:'2'},error:null,status:200}),9000)):new Promise(()=>{})
 }}))
 try{
  const shell=await import('../../../../apps/desktop/src/lib/assistantWorkShell')
  const failure=vi.fn()
  void shell.assistantWorkReads.client.listAll('assistant').catch(failure)
  await vi.advanceTimersByTimeAsync(15_001)
  expect(signals).toHaveLength(2)
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({code:'read-timeout'}))
  expect(signals[1]?.aborted).toBe(true)
 }finally{session.publishRendererSession('SIGNED_OUT',null);vi.clearAllTimers();vi.useRealTimers()}
})
