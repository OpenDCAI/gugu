import { describe, expect, it, vi } from 'vitest'
import { createAssistantWorkOutboxHost } from '../../../apps/desktop/electron/assistant-work-outbox'
const event={assistant_user_id:'assistant',work_id:'work',message_id:'message',kind:'completed' as const,from_session_id:'child',from_device_id:'phone',to_session_id:'home',to_device_id:'cloud',source_available:true,content:'fresh result',attachment_refs:[],platform_received_at:new Date().toISOString(),lease_until:new Date(Date.now()+60000).toISOString(),lease_token:'lease',lease_remaining_ms:60000,age_ms:0,failed_attempts:0,attempts:1,terminal_version:'1'}
function fixture(target='cloud') {
  let claimed=false
  const row={...event,to_device_id:target}
  const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_outbox_claim'?{events:claimed?[]:(claimed=true,[row])}:name==='assistant_work_history'?{events:[row],next_after:null}:{},error:null}))
  const deliverLocal=vi.fn(async()=>({admitted:true,messageId:'message',receipt:{agent_user_id:'agent'}}))
  const prepareRemote=vi.fn(async()=>undefined)
  const requestRemote=vi.fn(async()=>({requestId:'rpc',result:{status:'admitted',messageId:'message',receipt:{agent_user_id:'remote-agent'}}}))
  const subscribe=vi.fn(async()=>()=>{})
  const warn=vi.fn()
  const deps={context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',client:{rpc}}),deliverLocal,prepareRemote,requestRemote,subscribe,warn}
  return {deps,rpc,deliverLocal,prepareRemote,requestRemote,subscribe,warn}
}
describe('account delivery host',()=>{
  it('does not wait for realtime subscription before claiming queued work',async()=>{
    const f=fixture();let finish!:(off:()=>void)=>void
    f.subscribe.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const host=createAssistantWorkOutboxHost(f.deps)
    const kicked=host.kick()
    await vi.waitFor(()=>expect(f.deliverLocal).toHaveBeenCalledOnce(),{timeout:100})
    finish(()=>{});await kicked;host.stop()
  })
  it('reads local canonical history without binding assistant admission as an executor',async()=>{
    const f=fixture();const host=createAssistantWorkOutboxHost(f.deps);await host.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_history',expect.objectContaining({p_work_id:'work'}))
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle',expect.objectContaining({p_receipt:{}}))
    host.stop()
  })
  it('transmits only a cloud reference, after the remote wake path',async()=>{
    const f=fixture('phone');const host=createAssistantWorkOutboxHost(f.deps);await host.kick()
    expect(f.requestRemote).toHaveBeenCalledWith('phone','assistantWork.deliver',{assistant_id:'assistant',work_id:'work',message_id:'message'},expect.any(AbortSignal))
    expect(f.prepareRemote.mock.invocationCallOrder[0]).toBeLessThan(f.requestRemote.mock.invocationCallOrder[0]!)
    expect(f.deliverLocal).not.toHaveBeenCalled();host.stop()
  })
})
