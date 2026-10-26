// @vitest-environment jsdom
import {expect,it,vi} from 'vitest'
import type {Session} from '@supabase/supabase-js'
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
 const close=shell.installAssistantWorkShell()
 try{
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
