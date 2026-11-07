import { describe, expect, it, vi } from 'vitest'
import { createConnectionOperationApplication, ConnectionEffectRefused, type ConnectionEffectLedger } from '../../apps/desktop/electron/sessionpage/connection-operation-application'

const effect = { operationId: 'original-uuid', requestHash: 'hash', revision: '7', resourceKey: '["github","account"]',
  deviceId: 'device', operation: 'remove' as const, data: { providerId: 'github', accountId: 'account' } }
function setup(initial: ConnectionEffectLedger = {}) {
  let ledger = structuredClone(initial)
  const apply = vi.fn(async () => {})
  const acknowledge = vi.fn(async (_effect: typeof effect, _admissionId: string, _errorCode: string | null) => {})
  const admit = vi.fn(async (): Promise<string | null> => 'admission')
  const input = { deviceId: 'device', assertCurrent: vi.fn(), load: async () => structuredClone(ledger),
    save: vi.fn(async (value: ConnectionEffectLedger) => { ledger = structuredClone(value) }), apply, acknowledge, admit }
  return { application: createConnectionOperationApplication(input), input, ledger: () => ledger }
}
describe('durable owner connection operation execution', () => {
  it('uses the imported UUID, applies once and retries only a lost acknowledgement', async () => {
    const { application, input, ledger } = setup()
    input.acknowledge.mockRejectedValueOnce(new Error('RESPONSE_LOST'))
    await expect(application.apply(effect)).rejects.toThrow('RESPONSE_LOST')
    expect(ledger()[effect.operationId]?.state).toBe('applied')
    await application.apply(effect)
    expect(input.apply).toHaveBeenCalledExactlyOnceWith(effect)
    expect(input.acknowledge).toHaveBeenNthCalledWith(2, effect, 'admission', null)
  })
  it('stops on an unknown outcome after restart', async () => {
    const { application, input } = setup({ [effect.operationId]: { state: 'started', requestHash: effect.requestHash, admissionId: 'admission' } })
    await expect(application.apply(effect)).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    expect(input.apply).not.toHaveBeenCalled()
    expect(input.acknowledge).toHaveBeenCalledWith(effect, 'admission', 'CONNECTION_OUTCOME_UNKNOWN')
  })
  it('does not replay a database admission without a matching local completion', async () => {
    const { application,input } = setup()
    await expect(application.apply({ ...effect,admissionId: 'database-admission' })).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    expect(input.admit).not.toHaveBeenCalled()
    expect(input.apply).not.toHaveBeenCalled()
    expect(input.acknowledge).toHaveBeenCalledWith({ ...effect,admissionId: 'database-admission' },'database-admission','CONNECTION_OUTCOME_UNKNOWN')
  })
  it('does not replay an effect whose call throws after it starts', async () => {
    const { application, input, ledger } = setup()
    input.apply.mockRejectedValueOnce(new Error('OUTCOME_LOST'))
    await expect(application.apply(effect)).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    await expect(application.apply(effect)).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    expect(input.apply).toHaveBeenCalledTimes(1)
    expect(ledger()[effect.operationId]?.state).toBe('started')
  })
  it('records a known refusal without replaying it', async () => {
    const { application, input } = setup()
    input.apply.mockRejectedValueOnce(new ConnectionEffectRefused('CONNECTION_UNSUPPORTED'))
    await application.apply(effect)
    await application.apply(effect)
    expect(input.apply).toHaveBeenCalledTimes(1)
    expect(input.acknowledge).toHaveBeenLastCalledWith(effect, 'admission', 'CONNECTION_UNSUPPORTED')
  })
  it('refuses a reused UUID and a different execution device', async () => {
    const { application, input } = setup({ [effect.operationId]: { state: 'applied', requestHash: 'other-hash', admissionId: 'admission' } })
    await expect(application.apply(effect)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_REUSED' })
    await expect(application.apply({ ...effect, deviceId: 'other-device' })).rejects.toMatchObject({ code: 'CONNECTION_DEVICE_MISMATCH' })
    expect(input.apply).not.toHaveBeenCalled()
    expect(input.acknowledge).not.toHaveBeenCalled()
  })
  it('does not execute when admission has been superseded', async () => {
    const { application, input } = setup()
    input.admit.mockResolvedValueOnce(null)
    await application.apply(effect)
    expect(input.apply).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })
})
