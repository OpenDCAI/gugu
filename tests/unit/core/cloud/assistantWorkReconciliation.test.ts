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
  const f={context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',assistantId:'assistant',client:{rpc}}),works:vi.fn(async()=>[work]),history:vi.fn(async()=>events),abandoned:vi.fn(async()=>[]),inspect,notify,clean,stableId:async(k:string)=>k,warn:vi.fn(),now:()=>now}
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
