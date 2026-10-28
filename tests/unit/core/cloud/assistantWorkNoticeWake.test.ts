import { expect, it, vi } from 'vitest'
import { createAssistantWorkNoticeWakePump } from '../../../../packages/core/src/cloud/assistantWorkNoticeWake'

it('uses bounded server notice claims and lets another home proceed after one fails', async () => {
  const items=['bad','good'].map(home=>({anchor_message_id:home,coordinator_device_id:home,lease_token:`lease-${home}`,lease_remaining_ms:60000}))
  const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_notice_wake_claim'?{items}:{},error:null}))
  const wake=vi.fn(async(home:string)=>{if(home==='bad') throw new Error('offline')})
  const request=vi.fn(async()=>{})
  const pump=createAssistantWorkNoticeWakePump({context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'phone'}),rpc,wake,request,warn:vi.fn()})
  await pump.kick()
  expect(wake).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith('good',expect.any(AbortSignal))
  expect(rpc.mock.calls.filter(([name])=>name==='assistant_work_notice_wake_release')).toHaveLength(2)
  expect(rpc).not.toHaveBeenCalledWith('assistant_work_abandoned',expect.anything(),expect.anything())
  pump.stop()
})

it('does not retry or wake anything when the server has no eligible notice groups',async()=>{
  const wake=vi.fn()
  const pump=createAssistantWorkNoticeWakePump({context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'phone'}),rpc:async()=>({data:{items:[]},error:null}),wake,request:async()=>{},warn:vi.fn()})
  await pump.kick();await pump.kick();expect(wake).not.toHaveBeenCalled();pump.stop()
})

it('cancels a hanging home at the server lease budget and releases its notice claim',async()=>{
  vi.useFakeTimers()
  try {
    const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_notice_wake_claim'?{items:[{anchor_message_id:'notice',coordinator_device_id:'home',lease_token:'lease',lease_remaining_ms:6000}]}:{},error:null}))
    let signal:AbortSignal|undefined
    const pump=createAssistantWorkNoticeWakePump({context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'phone'}),rpc,wake:async(_home,s)=>{signal=s;return new Promise(()=>{})},request:async()=>{},warn:vi.fn()})
    const flight=pump.kick();await vi.advanceTimersByTimeAsync(1001);await flight
    expect(signal?.aborted).toBe(true)
    expect(rpc).toHaveBeenCalledWith('assistant_work_notice_wake_release',expect.objectContaining({p_anchor_message_id:'notice',p_lease_token:'lease'}),expect.anything())
    pump.stop()
  } finally {vi.useRealTimers()}
})
