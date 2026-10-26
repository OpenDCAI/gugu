import { describe, expect, it, vi } from 'vitest'
import { enqueueAssistantWorkReport } from '../../../../packages/core/src/cloud/assistantWorkReports'
const id = 'b316d3b6-6556-4231-a750-460c79dacb92'
const work = { work_id: id, assistant_user_id: 'assistant', coordinator_session_id: 'home-session', coordinator_device_id: 'cloud', executors: [{ session_id: 'child', device_id: 'phone' }] }
const input = { assistantId: 'assistant', runtimeInstanceId: 'runtime', sessionId: 'child', deviceId: 'phone', record: { to: ['session:home-session'], text: 'done', work_result: { work_id: id, status: 'completed' }, files: [{file_path: '/report.txt'}] } }
function fixture(row = work) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'assistant_work_history' ? { data: {work:row,events:[]},error:null } : { data:{work_id:id,event_ids:[(args.p_events as {message_id:string}[])[0]!.message_id],outcome:'completed',terminal_version:'1'},error:null })
  const prepare = vi.fn(async () => [])
  return {rpc,prepare, resolveNumbers:vi.fn(async()=>new Map<number,string>()), id:vi.fn(()=>id)}
}
describe('work report queues before a sleeping coordinator can be contacted', () => {
  it('uses cloud work routing and accepts the file without a live device lookup', async () => {
    const f=fixture()
    const receipt=await enqueueAssistantWorkReport(f,input)
    expect(receipt.recipients[0]?.status).toBe('accepted')
    expect(f.prepare).toHaveBeenCalledWith([{file_path:'/report.txt'}],{sessionId:'home-session',deviceId:'cloud',agentId:'assistant'})
    expect(f.rpc).toHaveBeenLastCalledWith('assistant_work_commit',expect.objectContaining({p_task:null,p_events:[expect.objectContaining({kind:'completed',to_device_id:'cloud',from_session_id:'child'})]}))
  })
  it('rejects a foreign executor before uploading a file', async () => {
    const f=fixture()
    await expect(enqueueAssistantWorkReport(f,{...input,sessionId:'intruder'})).rejects.toMatchObject({code:'WORK_EXECUTOR_MISMATCH'})
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledOnce()
  })
  it('rejects a target outside the canonical coordinator, rather than silently rerouting', async () => {
    const f=fixture()
    await expect(enqueueAssistantWorkReport(f,{...input,record:{...input.record,to:['session:another']}})).rejects.toMatchObject({code:'WORK_COORDINATOR_MISMATCH'})
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('fails if the work record cannot be read; it never invents an empty successful handoff', async () => {
    const f=fixture(null as never)
    await expect(enqueueAssistantWorkReport(f,input)).rejects.toMatchObject({code:'WORK_ROUTING_UNAVAILABLE'})
    expect(f.prepare).not.toHaveBeenCalled()
  })
})
