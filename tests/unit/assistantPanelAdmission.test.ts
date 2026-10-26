import { describe, expect, it, vi } from 'vitest'
import type { AssistantPanelChange, AssistantPanelClient } from '../../packages/core/src/cloud/assistantPanel'
import { prepareAssistantPanelAdmission } from '../../apps/desktop/electron/sessionpage/assistant-panel-admission'

const change: AssistantPanelChange = { operation_id: 'save',revision: '1',assistant_user_id: 'assistant',owner_user_id: 'owner',domain: 'memory',resource_key: 'note',
  device_id: 'home',operation: 'save',payload: {},status: 'pending',error_code: null }
function fixture() {
  const cloud = {
    pending: vi.fn<AssistantPanelClient['pending']>(async () => ({ revision: '1',changes: [change],notices: [] })),
    ack: vi.fn<AssistantPanelClient['ack']>(async (_assistant, _instance, operationId) => ({ operationId,revision: '1',status: 'applied' })),
    admit: vi.fn<AssistantPanelClient['admit']>(async () => ({ admitted: true,revision: '1' })),
  }
  const accepted = vi.fn(async () => {})
  const application = { apply: vi.fn(async (_change: AssistantPanelChange) => {}),inform: vi.fn(async (_notice: AssistantPanelChange) => {}),
    prepareText: vi.fn(async (text: string) => ({ text: `committed changes\n${text}`,accepted })) }
  const wait = vi.fn(async (_milliseconds: number) => {})
  const input = { assistant: 'assistant',instance: 'runtime',cloud: cloud as unknown as AssistantPanelClient,application,text: 'hello',wait }
  return { cloud,application,input,wait,accepted }
}

describe('assistant panel admission', () => {
  it('retries a transient effect before admission and leaves notice consumption to the actual receipt', async () => {
    const world = fixture()
    world.application.apply.mockRejectedValueOnce(new Error('FILE_WRITE_FAILED'))
    const prepared = await prepareAssistantPanelAdmission(world.input)
    expect(world.application.apply).toHaveBeenCalledTimes(2)
    expect(world.cloud.ack.mock.calls[0]).toEqual(['assistant','runtime','save','FILE_WRITE_FAILED'])
    expect(world.cloud.admit).toHaveBeenCalledOnce()
    expect(world.accepted).not.toHaveBeenCalled()
    expect(prepared.text).toBe('committed changes\nhello')
    await prepared.accepted()
    expect(world.accepted).toHaveBeenCalledOnce()
  })

  it('identifies an unapplied resource after bounded retries and never admits stale state', async () => {
    const world = fixture()
    world.application.apply.mockRejectedValue(new Error('FILE_WRITE_FAILED'))
    await expect(prepareAssistantPanelAdmission(world.input)).rejects.toMatchObject({ domain: 'memory',resourceKey: 'note',code: 'FILE_WRITE_FAILED' })
    expect(world.application.apply).toHaveBeenCalledTimes(3)
    expect(world.cloud.admit).not.toHaveBeenCalled()
    expect(world.application.prepareText).not.toHaveBeenCalled()
  })

  it('recovers from a superseded save and fetches the newer removal before admission', async () => {
    const world = fixture()
    world.application.apply.mockRejectedValueOnce(new Error('BODY_READ_FAILED'))
    world.cloud.ack.mockResolvedValueOnce({ operationId: 'save',revision: '1',status: 'superseded' })
    world.cloud.admit.mockRejectedValueOnce({ code: '40001' })
    world.cloud.pending.mockResolvedValueOnce({ revision: '1',changes: [change],notices: [] })
      .mockResolvedValueOnce({ revision: '2',changes: [{ ...change,operation_id: 'remove',operation: 'remove',revision: '2' }],notices: [] })
    expect((await prepareAssistantPanelAdmission(world.input)).text).toContain('hello')
    expect(world.application.apply.mock.calls.map(call => call[0].operation)).toEqual(['save','remove'])
    expect(world.cloud.pending).toHaveBeenCalledTimes(2)
  })

  it('does not block required effects or admission when an informational notice cannot be appended', async () => {
    const world = fixture()
    world.cloud.pending.mockResolvedValue({ revision: '1',changes: [change],notices: [{ ...change,operation: 'notice' }] })
    world.application.inform.mockRejectedValue(new Error('NOTICE_APPEND_FAILED'))
    expect((await prepareAssistantPanelAdmission(world.input)).text).toContain('hello')
    expect(world.application.apply).toHaveBeenCalledOnce()
    expect(world.cloud.ack).toHaveBeenCalledTimes(1)
    expect(world.cloud.admit).toHaveBeenCalledOnce()
  })
})
