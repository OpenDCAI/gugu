import { describe, expect, it, vi } from 'vitest'
import { buildSessionDirectEnvelope, readDeliveryEnvelope } from '../../../../packages/core/src/local/agent/deliveryEnvelope'
import { createAssistantWorkReconciler, type WorkReconciliationContext, type WorkReconciliationEvent } from '../../../../packages/core/src/cloud/assistantWorkReconciliation'
const now=Date.parse('2026-10-26T08:00:00Z')
const work={work_id:'work',assistant_user_id:'assistant',title:'天气表格',coordinator_session_id:'home',coordinator_device_id:'cloud',executors:[{session_id:'child',device_id:'phone'}],outcome:'active',executor_outcomes:{}}
const dispatch={message_id:'dispatch',kind:'dispatch',from_session_id:'home',from_device_id:'cloud',to_session_id:'child',to_device_id:'phone',platform_received_at:new Date(now-180000).toISOString(),executor_admitted_at:new Date(now-170000).toISOString()}
function fixture(events:WorkReconciliationEvent[]=[dispatch]) {
  const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:{work_id:'work',event_ids:['notice'],outcome:'failed',terminal_version:'1'},error:null}))
  const inspect=vi.fn(async()=>({preview:{running:false,ended:{kind:'done'},entries:[{kind:'prompt',messageId:'dispatch'}]}}))
  const notify=vi.fn(async(_ctx:WorkReconciliationContext,_key:string,_text:string)=>({chatId:'dm',messageId:'notice'}))
  const clean=vi.fn()
  const f={context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',assistantId:'assistant',client:{rpc}}),works:vi.fn(async()=>[work]),history:vi.fn(async()=>events),abandoned:vi.fn(async()=>[]),ownerReceipts:vi.fn(async()=>[] as Array<{eventId:string;chatId:string;messageId:string}>),verifyOwnerPost:vi.fn(async()=>true),inspect,notify,clean,stableId:async(k:string)=>k,warn:vi.fn(),now:()=>now}
  return {...f,rpc,reconciler:createAssistantWorkReconciler(f)}
}
describe('unfinished delivery reconciliation',()=>{
  it('reconciles a task from a former home using the current coordinator while preserving original report addresses',async()=>{
    const f=fixture([dispatch])
    f.works.mockResolvedValue([{...work,coordinator_session_id:'former-session',coordinator_device_id:'former-device',coordinator_current:{session_id:'current-session',device_id:'cloud'}}] as never)
    f.inspect.mockResolvedValue({preview:{running:false,ended:{kind:'done'},entries:[{kind:'prompt',messageId:dispatch.message_id}]}})
    await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.objectContaining({p_events:[expect.objectContaining({from_session_id:'current-session',from_device_id:'cloud',to_session_id:'former-session',to_device_id:'former-device'})]}))
  })
  it('does not inspect or notify an unbound moved coordinator',async()=>{
    const f=fixture([dispatch]);f.works.mockResolvedValue([{...work,coordinator_current:null}] as never)
    await f.reconciler.kick();expect(f.inspect).not.toHaveBeenCalled();expect(f.ownerReceipts).not.toHaveBeenCalled();expect(f.notify).not.toHaveBeenCalled()
  })
  it('records an inference only after the admitted dispatch is confirmed ended without a report',async()=>{
    const f=fixture();await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.objectContaining({p_events:[expect.objectContaining({kind:'failed',executor_session_id:'child',reason_code:'EXECUTOR_ENDED_WITHOUT_REPORT'})]}))
    expect(f.notify).not.toHaveBeenCalled()
  })
  it('matches the typed prompt ID emitted by a real session-direct envelope', async () => {
    const envelope = buildSessionDirectEnvelope({ senderSessionId: 'home', senderTitle: 'Assistant', messageId: dispatch.message_id, content: 'Make the weather sheet', at: '2026-10-26 15:57 北京时间' })
    const messageId = readDeliveryEnvelope(envelope)!.segments[0]!.facts!.messageId!
    expect(messageId).toBe('msg:dispatch')
    const f = fixture()
    f.inspect.mockResolvedValue({ preview: { running: false, ended: { kind: 'done' }, entries: [{ kind: 'prompt', messageId }] } })
    await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit', expect.objectContaining({ p_events: [expect.objectContaining({ reason_code: 'EXECUTOR_ENDED_WITHOUT_REPORT' })] }))
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
  it('uses trusted host failure evidence without another native inspection',async()=>{
    const f=fixture([dispatch,{kind:'progress',from_session_id:'child',message_id:'host-failure',reason_code:'HOST_FAILURE'}])
    await f.reconciler.kick()
    expect(f.inspect).not.toHaveBeenCalled();expect(f.notify).not.toHaveBeenCalled()
  })
  it('turns trusted host interruption evidence into a coordinator inference before notifying',async()=>{
    const f=fixture([dispatch,{kind:'progress',from_session_id:'child',message_id:'host-failure',reason_code:'HOST_FAILURE',assistant_admitted_at:new Date(now-10000).toISOString()}])
    await f.reconciler.kick()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.objectContaining({p_events:[expect.objectContaining({kind:'failed',executor_session_id:'child',reason_code:'HOST_FAILURE'})]}))
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
  it('does not treat progress as a result requiring native owner receipt scans',async()=>{
    const f=fixture([{kind:'progress',message_id:'failure',reason_code:'HOST_FAILURE',assistant_admitted_at:'2026-10-26T08:00:00Z'}])
    f.ownerReceipts.mockResolvedValue([{eventId:'failure',chatId:'dm',messageId:'actual-owner-post'}])
    await f.reconciler.kick()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.ownerReceipts).not.toHaveBeenCalled()
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
    expect(f.notify).toHaveBeenCalledOnce()
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
  it('groups notices by work and reason while keeping a late completed result distinct from a lost question',async()=>{
    const f=fixture([])
    f.abandoned.mockResolvedValue(['progress','completed','question','failed'].map((kind,index)=>({kind,message_id:`lost-${index}`,work_id:'work',assistant_user_id:'assistant',to_device_id:'cloud',abandoned_reason_code:'DELIVERY_TIMEOUT'})) as never)
    await f.reconciler.kick()
    expect(f.notify).toHaveBeenCalledTimes(2)
    expect(f.notify.mock.calls.map(row=>row[1])).toEqual(expect.arrayContaining([expect.stringContaining(':completed:'),expect.stringContaining(':handoff:')]))
    expect(f.rpc.mock.calls.filter(([name])=>name==='assistant_work_owner_delivered')).toHaveLength(3)
  })
  it('refuses missing owner posts and isolates one receipt failure from later proofs',async()=>{
    const f=fixture(['one','two'].map(message_id=>({kind:'completed',message_id,assistant_admitted_at:'2026-10-26T08:00:00Z'})))
    f.works.mockResolvedValue([{...work,outcome:'completed'}])
    f.ownerReceipts.mockResolvedValue([{eventId:'one',chatId:'dm',messageId:'post-one'},{eventId:'two',chatId:'dm',messageId:'post-two'}])
    f.rpc.mockResolvedValueOnce({data:null,error:{message:'temporary'}} as never)
    await f.reconciler.kick()
    expect(f.rpc.mock.calls.filter(([name])=>name==='assistant_work_owner_delivered')).toHaveLength(2)
    expect(f.verifyOwnerPost).toHaveBeenCalledTimes(2)
    const missing=fixture([])
    missing.abandoned.mockResolvedValue([{kind:'completed',message_id:'lost',work_id:'work',assistant_user_id:'assistant',to_device_id:'cloud',abandoned_reason_code:'DELIVERY_TIMEOUT'}] as never)
    missing.verifyOwnerPost.mockResolvedValue(false)
    await missing.reconciler.kick()
    expect(missing.rpc.mock.calls.some(([name])=>name==='assistant_work_owner_delivered')).toBe(false)
  })
  it('never posts an abandoned inference or question after a real executor result superseded it',async()=>{
    const f=fixture([])
    f.works.mockResolvedValue([{...work,outcome:'completed',executor_outcomes:{child:{status:'completed',origin:'executor'}}}])
    f.abandoned.mockResolvedValue([{kind:'failed',terminal_origin:'coordinator',executor_session_id:'child'},{kind:'question',from_session_id:'child'}].map((event,index)=>({...event,message_id:`old-${index}`,work_id:'work',assistant_user_id:'assistant',to_device_id:'cloud',abandoned_reason_code:'DELIVERY_TIMEOUT'})) as never)
    await f.reconciler.kick();expect(f.notify).not.toHaveBeenCalled()
  })
  it('does not recommit a host failure already represented by a coordinator terminal event',async()=>{
    const f=fixture([{kind:'progress',from_session_id:'child',message_id:'host-failure',reason_code:'HOST_FAILURE'},
      {kind:'failed',executor_session_id:'child',terminal_origin:'coordinator',message_id:'inference',reason_code:'HOST_FAILURE'}])
    f.works.mockResolvedValue([{...work,outcome:'failed',executor_outcomes:{child:{status:'failed',origin:'coordinator'}}}])
    await f.reconciler.kick();expect(f.rpc.mock.calls.some(([name])=>name==='assistant_work_commit')).toBe(false)
  })
  it('records and notifies an abandoned dispatch once without making it an executor terminal',async()=>{
    const f=fixture([])
    f.abandoned.mockResolvedValue([{kind:'dispatch',message_id:'lost-dispatch',work_id:'work',assistant_user_id:'assistant',from_device_id:'cloud',to_session_id:'child',abandoned_reason_code:'DELIVERY_TIMEOUT'}] as never)
    await f.reconciler.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_commit',expect.objectContaining({p_events:[expect.objectContaining({kind:'failed',from_session_id:'home',executor_session_id:'child',reason_code:'DELIVERY_TIMEOUT'})]}))
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_owner_delivered',expect.objectContaining({p_message_id:'lost-dispatch',p_receipt_kind:'abandonment_notice'}))
  })
})
