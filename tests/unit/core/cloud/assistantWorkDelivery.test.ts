import { describe, expect, it, vi } from 'vitest'
import { createAssistantWorkDeliveryReceiver, type AssistantWorkDeliveryEvent } from '../../../../packages/core/src/cloud/assistantWorkDelivery'

const event: AssistantWorkDeliveryEvent = { message_id: 'message', work_id: 'work', kind: 'completed', from_session_id: 'executor', from_device_id: 'phone',
  to_session_id: 'assistant', to_device_id: 'cloud', content: 'current result', source_available: true, attachment_refs: [], platform_received_at: '2026-10-26T00:00:00Z' }
function fixture(row = event) {
  const read = vi.fn(async () => row)
  const deliver = vi.fn(async () => ({ messageId: 'message', admitted: true }))
  const receiver = createAssistantWorkDeliveryReceiver({ context: async () => ({ ownerId: 'owner', deviceId: 'cloud' }), read, deliver })
  return { receiver, read, deliver }
}
describe('work delivery receiver', () => {
  it('joins concurrent wire replays until the actual admission settles', async () => {
    const f = fixture(); const gate = Promise.withResolvers<void>();
    f.deliver.mockImplementation(async () => { await gate.promise; return { messageId: 'message', admitted: true }; });
    const ref = { assistant_id: 'agent', work_id: 'work', message_id: 'message' };
    const first = f.receiver.receive(ref, 'owner');
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(1));
    const second = f.receiver.receive(ref, 'owner');
    try { await Promise.resolve(); await Promise.resolve(); expect(f.deliver).toHaveBeenCalledTimes(1); }
    finally { gate.resolve(); await Promise.allSettled([first, second]); }
    expect(f.deliver).toHaveBeenCalledOnce();
  })
  it('reads the canonical cloud event and preserves its stable identity and timestamp', async () => {
    const f = fixture()
    await expect(f.receiver.receive({ assistant_id: 'agent', work_id: 'work', message_id: 'message' }, 'owner')).resolves.toEqual({ status: 'admitted', messageId: 'message' })
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'message', content: 'current result', platform_received_at: '2026-10-26T00:00:00Z' }))
  })
  it('preserves the receiver identity binding from actual admission', async () => {
    const f = fixture()
    f.deliver.mockResolvedValue({messageId:'message',admitted:true,receipt:{agent_user_id:'agent-child'}} as never)
    await expect(f.receiver.receive({assistant_id:'agent',work_id:'work',message_id:'message'},'owner')).resolves.toMatchObject({status:'admitted',receipt:{agent_user_id:'agent-child'}})
  })
  it('does not use the sender cached body after its source becomes invisible', async () => {
    const f = fixture({ ...event, source_available: false, content: null } as never)
    await expect(f.receiver.receive({ assistant_id: 'agent', work_id: 'work', message_id: 'message', content: 'old cached result' }, 'owner')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('rejects a different owner before reading any work', async () => {
    const f = fixture()
    await expect(f.receiver.receive({ assistant_id: 'agent', work_id: 'work', message_id: 'message' }, 'other')).rejects.toMatchObject({ code: 'OWNER_CHANGED' })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('rejects a different destination device and never injects a model message', async () => {
    const f = fixture({ ...event, to_device_id: 'another' })
    await expect(f.receiver.receive({ assistant_id: 'agent', work_id: 'work', message_id: 'message' }, 'owner')).rejects.toMatchObject({ code: 'WRONG_DEVICE' })
    expect(f.deliver).not.toHaveBeenCalled()
  })
})
