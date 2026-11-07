import { describe,it,expect,vi } from 'vitest'
import { createConnectionVerificationReader } from '@/components/connections/connection-verification-read'
import type { ConnectionVerificationStore,ConnectionVerification } from '@/components/connections/connection-verification'
import type { ConnectionMetadataSnapshot } from '@/components/connections/connection-metadata'
import type { ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
const operationId = '10000000-0000-4000-8000-000000000001'
const result = (): ConnectionOperationStatus => ({ version: 1,operationId,scopeKey: 'device:one',resourceKey: 'original-key',deviceId: 'one',revision: '4',operation: 'save',
  original: { status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true },resolution: { outcome: 'applied',resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },
  effective: { state: 'succeeded',connectionState: 'connected',blocksNewOperations: false },confirmation: { state: 'resolved',deadlineAt: null } })
const row = { operationId,scopeKey: 'device:one',resourceKey: '["device:one","original-key"]',deviceId: 'one',revision: '4',operation: 'save',status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN' }
const snapshot = (operations = [row]) => ({ version: 1,revision: '4',items: [{ resource_key: row.resourceKey,source: { scopeKey: 'device:one',resourceKey: 'original-key' },
  device_id: 'one',revision: '4',data: { providerId: 'asana',accountId: 'actual' } }],application: operations } as unknown as ConnectionMetadataSnapshot)
function setup(local: ConnectionVerification[] = [],source = snapshot()) {
  let owner = 'owner'
  const ledger = { list: () => local,accept: vi.fn() } as unknown as ConnectionVerificationStore
  const operationStatus = vi.fn<(operationId: string) => Promise<ConnectionOperationStatus | null>>(async () => result())
  const effects = vi.fn(),changed = vi.fn(),cancel = vi.fn<(row: ConnectionVerification) => Promise<ConnectionOperationStatus | null>>(async () => null)
  const reader = createConnectionVerificationReader({ ledger,snapshot: () => source,client: { operationStatus,commit: effects } as unknown as Parameters<typeof createConnectionVerificationReader>[0]['client'],
    assertCurrent: () => { if (owner !== 'owner') throw new Error('ACCOUNT_CHANGED') },changed,cancel })
  return { reader,ledger,operationStatus,effects,changed,cancel,source,account: (next: string) => { owner = next } }
}
describe('read-only verification recovery',() => {
  it('reads the original UUID and overlays a resolution without rewriting its UNKNOWN receipt or any account',async () => {
    const f = setup(); await f.reader.refresh()
    expect(f.operationStatus).toHaveBeenCalledExactlyOnceWith(operationId)
    const projected = f.reader.project(f.source)
    expect(projected.application[0]).toMatchObject({ errorCode: 'CONNECTION_OUTCOME_UNKNOWN',effective: { state: 'succeeded' },resolution: { outcome: 'applied' } })
    expect(projected.items).toBe(f.source.items); expect(f.source.application[0]?.resolution).toBeUndefined()
    expect(f.effects).not.toHaveBeenCalled()
  })
  it('keeps a nullable pre-publication intent through a missing reply and a permission error',async () => {
    const local: ConnectionVerification = { operationId,providerId: 'asana',scopeKey: 'device:one',deviceId: 'one',resourceKey: null,operation: 'save',createdAt: 1,authorityEpoch: '1' }
    const f = setup([local],snapshot([])); f.operationStatus.mockResolvedValue(null)
    await f.reader.refresh(); expect(f.ledger.accept).not.toHaveBeenCalled()
    f.operationStatus.mockRejectedValue(Object.assign(new Error('CLOSED'),{ code: '42501' }))
    await expect(f.reader.refresh()).rejects.toMatchObject({ code: '42501' })
    expect(f.reader.project(f.source).verification?.[0]).toEqual(local); expect(f.effects).not.toHaveBeenCalled()
  })
  it.each([{ scopeKey: 'device:other',deviceId: 'other' },{ operationId: '10000000-0000-4000-8000-000000000002' }])('rejects a mismatched original identity %j',async mismatch => {
    const f = setup(); f.operationStatus.mockResolvedValue({ ...result(),...mismatch })
    await expect(f.reader.refresh()).rejects.toMatchObject({ code: 'invalid-response' })
    expect(f.reader.project(f.source).application[0]?.effective).toBeUndefined(); expect(f.effects).not.toHaveBeenCalled()
  })
  it('does not accept a late response after the owner changes',async () => {
    const f = setup(); f.operationStatus.mockImplementation(async () => { f.account('other'); return result() })
    await expect(f.reader.refresh()).rejects.toThrow('ACCOUNT_CHANGED')
    expect(f.ledger.accept).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled()
  })
  it('bounds each read sweep and rotates through a larger queue',async () => {
    const operations = Array.from({ length: 25 },(_,index) => ({ ...row,operationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12,'0')}` }))
    const f = setup([],snapshot(operations)); f.operationStatus.mockResolvedValue(null)
    await f.reader.refresh(); expect(f.operationStatus).toHaveBeenCalledTimes(16)
    await f.reader.refresh(); expect(f.operationStatus).toHaveBeenCalledTimes(32)
    expect(new Set(f.operationStatus.mock.calls.flat())).toEqual(new Set(operations.map(row => row.operationId)))
    expect(f.effects).not.toHaveBeenCalled()
  })
  it('publishes a received resolution even when another read fails, without repainting unchanged state',async () => {
    const secondId = '10000000-0000-4000-8000-000000000002',f = setup([],snapshot([row,{ ...row,operationId: secondId }]))
    f.operationStatus.mockImplementation(async id => { if (id === secondId) throw new Error('OFFLINE'); return result() })
    await expect(f.reader.refresh()).rejects.toThrow('OFFLINE')
    expect(f.reader.project(f.source).application[0]?.effective?.state).toBe('succeeded')
    expect(f.changed).toHaveBeenCalledOnce()
    await expect(f.reader.refresh()).rejects.toThrow('OFFLINE')
    expect(f.changed).toHaveBeenCalledOnce(); expect(f.effects).not.toHaveBeenCalled()
  })
  it('retries only the original cancellation when a reply is missing and then reads that UUID without replaying authorization',async () => {
    const local: ConnectionVerification = { operationId,providerId: 'asana',scopeKey: 'device:one',deviceId: 'one',resourceKey: null,operation: 'save',createdAt: 1,authorityEpoch: '1',cancelRequested: true }
    const f = setup([local],snapshot([])); f.operationStatus.mockResolvedValue(null)
    await f.reader.refresh(); await f.reader.refresh()
    expect(f.cancel).toHaveBeenCalledTimes(2); expect(f.cancel.mock.calls.map(([row]) => row.operationId)).toEqual([operationId,operationId])
    expect(f.operationStatus.mock.calls.flat()).toEqual([operationId,operationId]); expect(f.ledger.accept).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled()
  })
  it('keeps polling after the service acknowledges cancellation without sending more cancellation requests',async () => {
    const pending: ConnectionOperationStatus = { ...result(),resolution: null,effective: { state: 'confirming',connectionState: 'confirming',blocksNewOperations: true },confirmation: { state: 'pending',deadlineAt: null,cancelRequested: true } }
    const local: ConnectionVerification = { operationId,providerId: 'asana',scopeKey: 'device:one',deviceId: 'one',resourceKey: 'original-key',operation: 'save',createdAt: 1,authorityEpoch: '1',cancelRequested: true,status: pending }
    const f = setup([local],snapshot([]))
    await f.reader.refresh(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.ledger.accept).toHaveBeenCalledWith(operationId,result()); expect(f.effects).not.toHaveBeenCalled()
  })
  it('accepts successful evidence even when the concurrent cancellation request is unavailable',async () => {
    const local: ConnectionVerification = { operationId,providerId: 'asana',scopeKey: 'device:one',deviceId: 'one',resourceKey: null,operation: 'save',createdAt: 1,authorityEpoch: '1',cancelRequested: true }
    const f = setup([local],snapshot([])); f.cancel.mockRejectedValue(Object.assign(new Error('UNAVAILABLE'),{ code: '503' }))
    await f.reader.refresh(); expect(f.ledger.accept).toHaveBeenCalledWith(operationId,result()); expect(f.effects).not.toHaveBeenCalled()
    f.operationStatus.mockResolvedValue(null)
    await expect(f.reader.refresh()).rejects.toMatchObject({ code: '503' }); expect(f.effects).not.toHaveBeenCalled()
  })
})
