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
  const subscribe=vi.fn(async(_owner:string,_changed:()=>void,_live:(up:boolean)=>void)=>()=>{})
  const warn=vi.fn()
  const deps={context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',client:{rpc}}),deliverLocal,prepareRemote,requestRemote,subscribe,warn}
  return {deps,rpc,deliverLocal,prepareRemote,requestRemote,subscribe,warn}
}
describe('account delivery host',()=>{
  it('reconciles server-expired work after a realtime claim returns no deliveries',async()=>{
    const f=fixture();let changed!:()=>void
    f.rpc.mockResolvedValue({data:{events:[]},error:null})
    f.subscribe.mockImplementation(async(_owner:string,cb:()=>void)=>{changed=cb;return()=>{}})
    const afterDrain=vi.fn(async()=>{})
    const host=createAssistantWorkOutboxHost({...f.deps,afterDrain,active:async()=>false})
    try {
      await host.tick()
      await vi.waitFor(()=>expect(f.subscribe).toHaveBeenCalledOnce())
      changed()
      await vi.waitFor(()=>expect(afterDrain).toHaveBeenCalledOnce(),{timeout:500})
      expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_claim',expect.any(Object))
      expect(f.deliverLocal).not.toHaveBeenCalled()
      expect(f.requestRemote).not.toHaveBeenCalled()
    } finally {host.stop()}
  })
  it('reports a failed claim through the availability route without waking a receiver',async()=>{
    const f=fixture(),unavailable=vi.fn(async()=>{})
    f.rpc.mockResolvedValue({data:null,error:{code:'PGRST202',message:'missing migration'}} as never)
    const host=createAssistantWorkOutboxHost({...f.deps,unavailable})
    try {await host.kick();await host.kick()} finally {host.stop()}
    expect(unavailable).toHaveBeenCalledOnce()
    expect(f.prepareRemote).not.toHaveBeenCalled()
    expect(f.requestRemote).not.toHaveBeenCalled()
  })
  it('wakes only the projected current home when the historical target has moved',async()=>{
    const f=fixture('old-home');let claimed=false
    const row={...event,to_device_id:'old-home',delivery_target:{device_id:'new-home',session_id:'new-session'}}
    f.rpc.mockImplementation(async name=>({data:name==='assistant_work_outbox_claim'?{events:claimed?[]:(claimed=true,[row])}:{},error:null}))
    const host=createAssistantWorkOutboxHost(f.deps);await host.kick();host.stop()
    expect(f.prepareRemote).toHaveBeenCalledWith('new-home',expect.any(AbortSignal))
    expect(f.requestRemote).toHaveBeenCalledWith('new-home','assistantWork.deliver',expect.any(Object),expect.any(AbortSignal))
  })

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
  it('passes the same cancellation signal through remote preparation and local delivery',async()=>{
    const remote=fixture('phone');const remoteHost=createAssistantWorkOutboxHost(remote.deps);await remoteHost.kick();remoteHost.stop()
    expect(remote.prepareRemote).toHaveBeenCalledWith('phone',expect.any(AbortSignal))
    const local=fixture();const localHost=createAssistantWorkOutboxHost(local.deps);await localHost.kick();localHost.stop()
    expect(local.deliverLocal).toHaveBeenCalledWith(expect.objectContaining({message_id:'message'}),expect.any(AbortSignal))
  })
  it('does not delegate an empty online claim, then wakes an eligible offline target before sending its reference',async()=>{
    const f=fixture('phone');const eligible=f.rpc.getMockImplementation()!
    let offline=false
    f.rpc.mockImplementation(async name=>name==='assistant_work_outbox_claim'&&!offline?{data:{events:[]},error:null}:eligible(name))
    const host=createAssistantWorkOutboxHost(f.deps);await host.kick()
    expect(f.prepareRemote).not.toHaveBeenCalled();expect(f.requestRemote).not.toHaveBeenCalled()
    offline=true;await host.kick()
    expect(f.requestRemote).toHaveBeenCalledWith('phone','assistantWork.deliver',{assistant_id:'assistant',work_id:'work',message_id:'message'},expect.any(AbortSignal))
    expect(f.prepareRemote.mock.invocationCallOrder[0]).toBeLessThan(f.requestRemote.mock.invocationCallOrder[0]!)
    expect(f.deliverLocal).not.toHaveBeenCalled();host.stop()
  })
  it('heartbeat ticks claim only for an account with an assistant; new work still lands through the realtime change',async()=>{
    const f=fixture();let changed!:()=>void
    f.subscribe.mockImplementation(async(_owner:string,cb:()=>void)=>{changed=cb;return()=>{}})
    const afterDrain=vi.fn(async()=>{})
    let assistant=false
    const host=createAssistantWorkOutboxHost({...f.deps,afterDrain,active:async()=>assistant})
    const claims=()=>f.rpc.mock.calls.filter(([name])=>name==='assistant_work_outbox_claim').length
    await host.tick();await host.tick()
    expect(claims()).toBe(0)
    expect(afterDrain).not.toHaveBeenCalled()
    await vi.waitFor(()=>expect(f.subscribe).toHaveBeenCalledOnce())
    changed()
    await vi.waitFor(()=>expect(f.deliverLocal).toHaveBeenCalledOnce())
    await vi.waitFor(()=>expect(afterDrain).toHaveBeenCalledOnce())
    expect(claims()).toBeGreaterThan(0)
    const before=claims();assistant=true
    await host.tick()
    expect(claims()).toBeGreaterThan(before)
    expect(afterDrain).toHaveBeenCalledTimes(2)
    host.stop()
  })
  it('a tick claims as before when the assistant check fails, and event kicks never wait for it',async()=>{
    const f=fixture();const active=vi.fn(async()=>{throw new Error('provisions unreadable')})
    const host=createAssistantWorkOutboxHost({...f.deps,active})
    await host.tick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_claim',expect.any(Object))
    const g=fixture();const never=vi.fn(async()=>false)
    const other=createAssistantWorkOutboxHost({...g.deps,active:never})
    await other.kick()
    expect(never).not.toHaveBeenCalled()
    expect(g.rpc).toHaveBeenCalledWith('assistant_work_outbox_claim',expect.any(Object))
    host.stop();other.stop()
  })
  it('while the work channel is live a heartbeat claim is only a safety net; once it drops, every heartbeat claims',async()=>{
    const f=fixture();let live!:(up:boolean)=>void
    f.subscribe.mockImplementation(async(_owner:string,_changed:()=>void,up:(up:boolean)=>void)=>{live=up;return()=>{}})
    const host=createAssistantWorkOutboxHost({...f.deps,active:async()=>true,safetyIntervalMs:60_000})
    const claims=()=>f.rpc.mock.calls.filter(([name])=>name==='assistant_work_outbox_claim').length
    await host.tick()
    await vi.waitFor(()=>expect(f.subscribe).toHaveBeenCalledOnce())
    live(true)
    const subscribed=claims()
    await host.tick();await host.tick()
    expect(claims()).toBe(subscribed)
    live(false)
    await host.tick()
    expect(claims()).toBeGreaterThan(subscribed)
    host.stop()
  })
  it('a failed delivery is claimed again when its backoff ends, not at the next safety claim',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
    try {
      const f=fixture()
      f.deliverLocal.mockRejectedValueOnce(Object.assign(new Error('session busy'),{code:'SESSION_RUNTIME_FAILED'}))
      let pending=true
      f.rpc.mockImplementation(async(name:string)=>({data:name==='assistant_work_outbox_claim'?{events:pending?[event]:[]}:name==='assistant_work_history'?{events:[event],next_after:null}:{},error:null}))
      const host=createAssistantWorkOutboxHost({...f.deps,active:async()=>true,safetyIntervalMs:60*60_000})
      const claims=()=>f.rpc.mock.calls.filter(([name])=>name==='assistant_work_outbox_claim').length
      await host.kick()
      expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle',expect.objectContaining({p_stage:'retry',p_retry_after_seconds:5}))
      pending=false
      const afterFailure=claims()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(claims()).toBe(afterFailure)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(claims()).toBeGreaterThan(afterFailure)
      host.stop()
    } finally { vi.useRealTimers() }
  })
})
