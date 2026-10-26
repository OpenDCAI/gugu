import { describe, expect, it, vi } from 'vitest'
import type { AssistantPanelChange, AssistantPanelClient } from '../../packages/core/src/cloud/assistantPanel'
import { prepareAssistantPanelAdmission } from '../../apps/desktop/electron/sessionpage/assistant-panel-admission'

const change: AssistantPanelChange = { operation_id: 'save',revision: '1',assistant_user_id: 'assistant',owner_user_id: 'owner',domain: 'memory',resource_key: 'note',
  device_id: 'home',operation: 'save',payload: {},status: 'pending',error_code: null }
function fixture() {
  const cloud = {
    pending: vi.fn<AssistantPanelClient['pending']>(async () => ({ revision: '1',changes: [change],notices: [] })),
    ack: vi.fn<AssistantPanelClient['ack']>(async (_assistant, _instance, operationId) => ({ operationId,revision: '1',status: 'applied' })),
    reject: vi.fn<AssistantPanelClient['reject']>(async (_assistant,_instance,operationId,_errorCode) => ({ operationId,revision: '1',status: 'failed',terminal: true })),
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
  it('terminally rejects a persistent effect and delivers its explanation before admitting later work', async () => {
    const world = fixture()
    const later = { ...change,operation_id: 'later',resource_key: 'later',revision: '2' }
    const notice = { ...change,operation_id: 'failure-notice',domain: 'notice',resource_key: 'failure',operation: 'notice' as const,
      payload: { failure: { operationId: 'save',domain: 'memory',resourceKey: 'note',errorCode: 'EACCES' } } }
    world.cloud.pending.mockResolvedValueOnce({ revision: '2',changes: [change,later],notices: [] })
      .mockResolvedValue({ revision: '2',changes: [],notices: [notice] })
    world.application.apply.mockImplementation(async item => { if (item.operation_id === 'save') throw Object.assign(new Error('permission denied'),{ code: 'EACCES' }) })
    expect((await prepareAssistantPanelAdmission(world.input)).text).toContain('hello')
    expect(world.application.apply.mock.calls.map(([row]) => row.operation_id)).toEqual(['save','save','save','later'])
    expect(world.cloud.reject).toHaveBeenCalledExactlyOnceWith('assistant','runtime','save','EACCES')
    expect(world.application.inform).toHaveBeenCalledWith(notice)
    expect(world.cloud.pending).toHaveBeenCalledTimes(2)
    expect(world.cloud.admit).toHaveBeenCalledOnce()
  })
  it('retries a transient effect before admission and leaves notice consumption to the actual receipt', async () => {
    const world = fixture()
    world.application.apply.mockRejectedValueOnce(new Error('FILE_WRITE_FAILED'))
    const prepared = await prepareAssistantPanelAdmission(world.input)
    expect(world.application.apply).toHaveBeenCalledTimes(2)
    expect(world.cloud.ack.mock.calls).toEqual([['assistant','runtime','save']])
    expect(world.cloud.admit).toHaveBeenCalledOnce()
    expect(world.accepted).not.toHaveBeenCalled()
    expect(prepared.text).toBe('committed changes\nhello')
    await prepared.accepted()
    expect(world.accepted).toHaveBeenCalledOnce()
  })

  it('identifies an unsettled failure if its terminal receipt cannot be recorded', async () => {
    const world = fixture()
    world.application.apply.mockRejectedValue(new Error('FILE_WRITE_FAILED'))
    world.cloud.reject.mockRejectedValue(new Error('network'))
    await expect(prepareAssistantPanelAdmission(world.input)).rejects.toMatchObject({ domain: 'memory',resourceKey: 'note',code: 'CHANGE_ACK_UNAVAILABLE' })
    expect(world.application.apply).toHaveBeenCalledTimes(3)
    expect(world.cloud.admit).not.toHaveBeenCalled()
    expect(world.application.prepareText).not.toHaveBeenCalled()
  })

  it('recovers from a superseded save and fetches the newer removal before admission', async () => {
    const world = fixture()
    world.application.apply.mockImplementation(async row => { if (row.operation === 'save') throw new Error('BODY_READ_FAILED') })
    world.cloud.reject.mockResolvedValueOnce({ operationId: 'save',revision: '1',status: 'superseded' })
    world.cloud.admit.mockRejectedValueOnce({ code: '40001' })
    world.cloud.pending.mockResolvedValueOnce({ revision: '1',changes: [change],notices: [] })
      .mockResolvedValueOnce({ revision: '2',changes: [{ ...change,operation_id: 'remove',operation: 'remove',revision: '2' }],notices: [] })
    expect((await prepareAssistantPanelAdmission(world.input)).text).toContain('hello')
    expect(world.application.apply.mock.calls.map(call => call[0].operation)).toEqual(['save','save','save','remove'])
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

  it('retries lost acknowledgements and reports the exact resource if acknowledgements remain unavailable', async () => {
    const transient = fixture()
    transient.cloud.ack.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'))
    await expect(prepareAssistantPanelAdmission(transient.input)).resolves.toMatchObject({ text: expect.stringContaining('hello') })
    expect(transient.application.apply).toHaveBeenCalledTimes(1)
    const failed = fixture()
    failed.cloud.ack.mockRejectedValue(new Error('network'))
    await expect(prepareAssistantPanelAdmission(failed.input)).rejects.toMatchObject({ domain: 'memory',resourceKey: 'note',code: 'CHANGE_ACK_UNAVAILABLE' })
    expect(failed.application.apply).toHaveBeenCalledTimes(1)
    expect(failed.cloud.admit).not.toHaveBeenCalled()
  })
})


it('waits through a renewing runtime lease and retries unavailable cloud admission before refusing the input', async () => {
  const f = fixture()
  f.cloud.pending.mockRejectedValueOnce({ code: '42501' }).mockRejectedValueOnce(new Error('network'))
  f.cloud.admit.mockRejectedValueOnce(new Error('network'))
  await expect(prepareAssistantPanelAdmission(f.input)).resolves.toMatchObject({ text: expect.stringContaining('hello') })
  expect(f.cloud.pending).toHaveBeenCalledTimes(3)
  expect(f.cloud.admit).toHaveBeenCalledTimes(2)
  expect(f.wait).toHaveBeenCalled()
})
