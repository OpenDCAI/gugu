import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantWorkOutboxPump, enqueueAssistantWorkDelivery, type ClaimedAssistantWorkEvent } from '../../../../packages/core/src/cloud/assistantWorkOutbox'
import { DeviceRpcTimeoutError } from '../../../../packages/core/src/cloud/deviceRpcRequester'

const context = { ownerId: 'owner', runtimeInstanceId: 'runtime', deviceId: 'mac' }
const event = (extra: Partial<ClaimedAssistantWorkEvent> = {}): ClaimedAssistantWorkEvent => ({
  message_id: 'message', work_id: 'work', kind: 'completed', from_session_id: 'executor', from_device_id: 'phone',
  to_session_id: 'assistant', to_device_id: 'cloud', content: 'A result', attachment_refs: [], source_available: true,
  lease_token: 'lease', lease_until: '2026-10-26T01:01:00Z', platform_received_at: '2026-10-26T01:00:00Z',
  failed_attempts: 0, attempts: 1, terminal_version: '1', lease_remaining_ms: 60_000, age_ms: 0, ...extra,
})
function fixture(events = [event()], localNow = Date.parse('2026-10-26T01:00:00Z')) {
  let claimed = false
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>, _context?: typeof context): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => ({ data: name === 'assistant_work_outbox_claim'
    ? { events: claimed ? [] : (claimed = true, events) } : {}, error: null }))
  const deliver = vi.fn(async (row: ReturnType<typeof event>, _signal: AbortSignal) => ({ status: 'admitted' as const, messageId: row.message_id }))
  const warn = vi.fn()
  const pump = createAssistantWorkOutboxPump({ context: async () => context, rpc, deliver, warn, now: () => localNow })
  return { pump, rpc, deliver, warn }
}
afterEach(() => { vi.useRealTimers() })
describe('one account work outbox', () => {
  it('returns acceptance only after the atomic cloud commit; never attempts direct delivery', async () => {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: { work_id: 'work', event_ids: ['message'], outcome: 'active', terminal_version: '0' }, error: null }))
    const input = { assistantId: 'assistant', runtimeInstanceId: 'runtime', operationId: 'operation', workId: 'work', task: null, events: [event()] }
    await expect(enqueueAssistantWorkDelivery({ rpc }, input)).resolves.toEqual({ status: 'accepted', work_id: 'work', event_ids: ['message'], outcome: 'active', terminal_version: '0' })
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0]).toEqual(['assistant_work_commit', { p_assistant: 'assistant', p_runtime_instance_id: 'runtime', p_operation_id: 'operation', p_work_id: 'work', p_task: null, p_events: input.events }])
  })
  it('does not acknowledge a rejected atomic commit', async () => {
    await expect(enqueueAssistantWorkDelivery({ rpc: async () => ({ data: null, error: { code: '42501', message: 'not owned' } }) },
      { assistantId: 'assistant', runtimeInstanceId: 'runtime', operationId: 'operation', workId: 'work', task: null, events: [] })).rejects.toMatchObject({ code: '42501' })
  })
  it('retains the original message ID across a lost acceptance acknowledgement', async () => {
    const f = fixture(); f.rpc.mockImplementationOnce(async () => ({ data: { events: [event()] }, error: null }))
    f.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: 'NETWORK', message: 'lost settlement' } }))
    await f.pump.kick()
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'message' }), expect.any(AbortSignal))
    expect(f.rpc.mock.calls.some(([name, args]) => name === 'assistant_work_outbox_settle' && args.p_stage === 'retry')).toBe(false)
  })
  it('marks assistant admission only after the recipient confirms the same stable ID', async () => {
    const f = fixture(); await f.pump.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_message_id: 'message', p_lease_token: 'lease', p_stage: 'assistant_admitted' }), context)
  })
  it('binds executor identity only for dispatch, never for report admission', async () => {
    for (const kind of ['dispatch', 'completed'] as const) {
      const f = fixture([event({ kind })])
      f.deliver.mockResolvedValue({ status: 'admitted', messageId: 'message', receipt: { agent_user_id: 'actual-executor' } } as never)
      await f.pump.kick()
      expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({
        p_stage: kind === 'dispatch' ? 'executor_admitted' : 'assistant_admitted',
        p_receipt: kind === 'dispatch' ? { agent_user_id: 'actual-executor' } : {},
      }), context)
    }
  })
  it('does not mistake recipient pending for admission', async () => {
    const f = fixture(); f.deliver.mockResolvedValue({ status: 'pending' } as never); await f.pump.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'retry', p_error_code: 'NOT_ADMITTED' }), context)
  })
  it('never delivers cached text when the source is no longer visible', async () => {
    const f = fixture([event({ source_available: false, content: null })]); await f.pump.kick()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'abandoned', p_error_code: 'SOURCE_UNAVAILABLE' }), context)
  })
  it('counts actual failures rather than lease attempts towards the limit', async () => {
    const f = fixture([event({ attempts: 100, failed_attempts: 0 })]); await f.pump.kick(); expect(f.deliver).toHaveBeenCalledOnce()
  })
  it('abandons after 100 real failures, preserving the row and its reason', async () => {
    const f = fixture([event({ failed_attempts: 100, last_error_code: 'DEVICE_OFFLINE' })]); await f.pump.kick()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'abandoned', p_error_code: 'DEVICE_OFFLINE' }), context)
  })
  it('abandons after 24 hours even if no other runtime attempted it', async () => {
    const f = fixture([event({ platform_received_at: '2026-10-25T01:00:00Z', age_ms: 86_400_000 })]); await f.pump.kick()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'abandoned', p_error_code: 'DELIVERY_EXPIRED' }), context)
  })
  it.each([-55_000, 86_400_000])('uses server budgets despite a device clock skew of %i ms', async skew => {
    const f = fixture([event()], Date.parse('2026-10-26T01:00:00Z') + skew)
    await f.pump.kick()
    expect(f.deliver).toHaveBeenCalledOnce()
    expect(f.rpc.mock.calls.some(([name, args]) => name === 'assistant_work_outbox_settle' && args.p_stage === 'abandoned')).toBe(false)
  })
  it('uses server age rather than a future platform timestamp on a slow device', async () => {
    const f = fixture([event({ age_ms: 86_400_000, platform_received_at: '2026-10-27T01:00:00Z' })])
    await f.pump.kick()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'abandoned', p_error_code: 'DELIVERY_EXPIRED' }), context)
  })
  it('will not deliver when the server lease has expired even if the local clock says otherwise', async () => {
    const f = fixture([event({ lease_remaining_ms: 0 })])
    await f.pump.kick()
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('leaves an unreachable receiver in the same cloud queue with bounded retry delay', async () => {
    const f = fixture(); f.deliver.mockRejectedValue(Object.assign(Error('private detail'), { code: 'DEVICE_OFFLINE' })); await f.pump.kick()
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_stage: 'retry', p_error_code: 'DEVICE_OFFLINE', p_retry_after_seconds: 5 }), context)
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain('private detail')
  })
  it('preserves structured timeout and lowercase protocol reasons without logging private messages',async()=>{
    for(const [error,code] of [[new DeviceRpcTimeoutError('private timeout details'),'DELIVERY_TIMEOUT'],
      [Object.assign(Error('private protocol details'),{code:'unknown_method'}),'UNKNOWN_METHOD']] as const) {
      const f=fixture();f.deliver.mockRejectedValue(error);await f.pump.kick()
      expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle',expect.objectContaining({p_stage:'retry',p_error_code:code}),context)
      expect(JSON.stringify(f.warn.mock.calls)).not.toContain('private')
    }
  })
  it('bounds a stalled receiver and does not block the other receiver', async () => {
    vi.useFakeTimers(); const f = fixture([event(), event({ message_id: 'second',to_session_id:'another-receiver' })])
    f.deliver.mockImplementation(async (row) => row.message_id === 'message' ? new Promise(() => {}) : { status: 'admitted', messageId: row.message_id })
    const done = f.pump.kick(); await vi.advanceTimersByTimeAsync(46_000); await done
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_message_id: 'second', p_stage: 'assistant_admitted' }), context)
    expect(f.rpc).toHaveBeenCalledWith('assistant_work_outbox_settle', expect.objectContaining({ p_message_id: 'message', p_stage: 'retry', p_error_code: 'DELIVERY_TIMEOUT' }), context)
  })
  it('does not overtake an earlier message to the same receiver when that message was not admitted',async()=>{
    const f=fixture([event(),event({message_id:'followup'})])
    f.deliver.mockResolvedValueOnce({status:'pending'} as never)
    await f.pump.kick()
    expect(f.deliver).toHaveBeenCalledTimes(1)
    expect(f.rpc.mock.calls.some(([name,args])=>name==='assistant_work_outbox_settle'&&args.p_message_id==='followup')).toBe(false)
  })
  it('does not claim twice concurrently when delivery events arrive in a burst', async () => {
    const f = fixture(); await Promise.all([f.pump.kick(), f.pump.kick(), f.pump.kick()])
    expect(f.deliver).toHaveBeenCalledOnce()
  })
  it('drains the next FIFO batch immediately after consuming a short batch',async()=>{
    const f=fixture();let batch=0
    f.rpc.mockImplementation(async name=>({data:name==='assistant_work_outbox_claim'?{events:batch++<2?[event({message_id:`batch-${batch}`})]:[]}: {},error:null}))
    await f.pump.kick()
    expect(f.deliver.mock.calls.map(([row])=>row.message_id)).toEqual(['batch-1','batch-2'])
  })
})
