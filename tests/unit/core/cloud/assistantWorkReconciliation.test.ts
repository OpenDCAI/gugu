import { describe, expect, it, vi } from 'vitest'
import { createAssistantWorkReconciler, type WorkReconciliationContext, type WorkReconciliationEvent } from '../../../../packages/core/src/cloud/assistantWorkReconciliation'
const now=Date.parse('2026-10-26T08:00:00Z')
const work={work_id:'work',assistant_user_id:'assistant',title:'天气表格',coordinator_session_id:'home',coordinator_device_id:'cloud',executors:[{session_id:'child',device_id:'phone'}],outcome:'active',executor_outcomes:{}}
const dispatch={message_id:'dispatch',kind:'dispatch',from_session_id:'home',from_device_id:'cloud',to_session_id:'child',to_device_id:'phone',platform_received_at:new Date(now-180000).toISOString(),executor_admitted_at:new Date(now-170000).toISOString()}
function fixture(events:WorkReconciliationEvent[]=[dispatch]) {
  const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:{work_id:'work',event_ids:['notice'],outcome:'failed',terminal_version:'1'},error:null}))
  const inspect=vi.fn(async()=>({preview:{running:false,ended:{kind:'done'},entries:[{kind:'prompt',messageId:'dispatch'}]}}))
  const notify=vi.fn(async(_ctx:WorkReconciliationContext,_key:string,_text:string)=>({chatId:'dm',messageId:'notice'}))
  const clean=vi.fn()
  const f={context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',assistantId:'assistant',client:{rpc}}),works:vi.fn(async()=>[work]),history:vi.fn(async()=>events),abandoned:vi.fn(async()=>[]),ownerReceipts:vi.fn(async()=>[] as Array<{eventId:string;chatId:string;messageId:string}>),inspect,notify,clean,stableId:async(k:string)=>k,warn:vi.fn(),now:()=>now}
  return {...f,rpc,reconciler:createAssistantWorkReconciler(f)}
}
describe('unfinished delivery reconciliation',()=>{
  it('records an inference only after the admitted dispatch is confirmed ended without a report',async()=>{
    const f=fixture();await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.objectContaining({p_events:[expect.objectContaining({kind:'failed',executor_session_id:'child',reason_code:'EXECUTOR_ENDED_WITHOUT_REPORT'})]}))
    expect(f.notify).not.toHaveBeenCalled()
  })
  it('does not let an older question hide a missing result after a later dispatch',async()=>{
    const f=fixture([{kind:'question',from_session_id:'child',message_id:'old-question'},dispatch]);await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.any(Object))
  })
  it('does not equate idle or an older ended turn with task completion',async()=>{
    const f=fixture();f.inspect.mockResolvedValue({preview:{running:false,ended:{kind:'done'},entries:[]}})
    await f.reconciler.kick();expect(f.rpc).not.toHaveBeenCalled()
  })
  it('does not declare a silent running turn failed',async()=>{
    const f=fixture();f.inspect.mockResolvedValue({preview:{running:true,ended:null,entries:[{kind:'prompt',messageId:'dispatch'}]}} as never)
    await f.reconciler.kick();expect(f.rpc).not.toHaveBeenCalled()
  })
  it('keeps a real executor report even if it has not reached the assistant yet',async()=>{
    const f=fixture([dispatch,{kind:'completed',from_session_id:'child',message_id:'result'}]);await f.reconciler.kick()
    expect(f.inspect).not.toHaveBeenCalled();expect(f.rpc).not.toHaveBeenCalled()
  })
  it('keeps a durable host failure as progress and does not infer another terminal failure',async()=>{
    const f=fixture([dispatch,{kind:'progress',from_session_id:'child',message_id:'host-failure',reason_code:'HOST_FAILURE'}])
    await f.reconciler.kick()
    expect(f.inspect).not.toHaveBeenCalled();expect(f.rpc).not.toHaveBeenCalled();expect(f.notify).not.toHaveBeenCalled()
  })
  it('notifies an admitted host failure once using its own committed event receipt',async()=>{
    const f=fixture([dispatch,{kind:'progress',from_session_id:'child',message_id:'host-failure',reason_code:'HOST_FAILURE',assistant_admitted_at:new Date(now-10000).toISOString()}])
    await f.reconciler.kick()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_message_id:'host-failure',p_receipt_kind:'result'}))
    expect(f.rpc.mock.calls.some(([name])=>name==='assistant_work_commit')).toBe(false)
  })
  it('recovers an actual owner post receipt even after the task completed, without reposting',async()=>{
    const f=fixture([{kind:'completed',message_id:'result',assistant_admitted_at:'2026-10-26T08:00:00Z'}])
    f.works.mockResolvedValue([{...work,outcome:'completed'}])
    f.ownerReceipts.mockResolvedValue([{eventId:'result',chatId:'dm',messageId:'actual-owner-post'}])
    f.rpc.mockResolvedValueOnce({data:null,error:{message:'temporary failure'}} as never)
    await f.reconciler.kick();await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledTimes(2)
    expect(f.rpc.mock.calls[0]).toEqual(f.rpc.mock.calls[1])
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_message_id:'result',p_owner_message_id:'actual-owner-post'}))
    expect(f.notify).not.toHaveBeenCalled();expect(f.clean).toHaveBeenCalledOnce()
  })
  it('does not repeat a host-failure notice already committed in the report turn',async()=>{
    const f=fixture([{kind:'progress',message_id:'failure',reason_code:'HOST_FAILURE',assistant_admitted_at:'2026-10-26T08:00:00Z'}])
    f.ownerReceipts.mockResolvedValue([{eventId:'failure',chatId:'dm',messageId:'actual-owner-post'}])
    await f.reconciler.kick()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_message_id:'failure'}))
  })
  it('does not notify obsolete inferred or host failures superseded by a real executor terminal',async()=>{
    for(const event of [{kind:'failed',terminal_origin:'coordinator',executor_session_id:'child'},
      {kind:'progress',reason_code:'HOST_FAILURE',from_session_id:'child'}]) {
      const f=fixture([{...event,message_id:'obsolete',assistant_admitted_at:'2026-10-26T08:00:00Z'}])
      f.works.mockResolvedValue([{...work,executor_outcomes:{child:{status:'completed',origin:'executor'}}}])
      await f.reconciler.kick();expect(f.notify).not.toHaveBeenCalled()
    }
  })
  it('posts one stable plain failure notice only after assistant admission and records the separate receipt',async()=>{
    const f=fixture([dispatch,{message_id:'failed',kind:'failed',terminal_origin:'coordinator',reason_code:'EXECUTOR_ENDED_WITHOUT_REPORT',assistant_admitted_at:new Date(now-10000).toISOString(),owner_delivered_at:null}])
    await f.reconciler.kick();await f.reconciler.kick()
    expect(f.notify.mock.calls[0]).toEqual(f.notify.mock.calls[1])
    expect(f.notify.mock.calls[0]?.[2]).toMatch(/天气表格.*没有交回结果/)
    expect(f.notify.mock.calls[0]?.[2]).not.toMatch(/work|session|runtime/)
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_receipt_kind:'result',p_owner_message_id:'notice'}))
  })
  it('does not post an uncommitted owner receipt when posting fails',async()=>{
    const f=fixture();f.abandoned.mockResolvedValue([{message_id:'lost',work_id:'work',assistant_user_id:'assistant',kind:'completed',to_device_id:'cloud',abandoned_reason_code:'DELIVERY_TIMEOUT'}] as never)
    f.notify.mockRejectedValue(new Error('offline'));await f.reconciler.kick()
    expect(f.rpc.mock.calls.some(([name])=>name==='assistant_work_owner_delivered')).toBe(false)
  })
  it('keeps abandonment notice distinct from successful result delivery',async()=>{
    const f=fixture([]);f.abandoned.mockResolvedValue([{message_id:'lost',work_id:'work',assistant_user_id:'assistant',kind:'completed',to_device_id:'cloud',abandoned_reason_code:'DELIVERY_TIMEOUT'}] as never)
    await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_receipt_kind:'abandonment_notice'}))
  })
})
