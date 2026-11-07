import { describe,it,expect,vi } from 'vitest'
import { createConnectionVerification } from '@/components/connections/connection-verification'
import type { ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
import { assertConnectionApplicationAvailable } from '@/components/connections/connection-action-guard'
const operationId = '10000000-0000-4000-8000-000000000001',secondId = '10000000-0000-4000-8000-000000000002'
const intent = { operationId,providerId: 'asana',scopeKey: 'device:one',deviceId: 'one',resourceKey: null,operation: 'save' as const }
const status = (): ConnectionOperationStatus => ({ version: 1,operationId,scopeKey: 'device:one',resourceKey: null,deviceId: 'one',revision: null,operation: 'save',
  original: { status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true },resolution: null,
  effective: { state: 'confirming',connectionState: 'confirming',blocksNewOperations: true },confirmation: { state: 'pending',deadlineAt: null } })
function setup() {
  const rows = new Map<string,string>(); let owner = 'owner'
  const storage = { get length() { return rows.size },key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null,setItem: vi.fn((key: string,value: string) => { rows.set(key,value) }),removeItem: (key: string) => { rows.delete(key) } }
  const open = (ownerId = 'owner',epoch = '1') => createConnectionVerification({ ownerId,epoch,accountId: () => owner,storage,changed: vi.fn() })
  return { open,rows,storage,account: (next: string) => { owner = next } }
}
describe('durable public verification identities',() => {
  it('retains the original UUID and starting epoch across reconstruction without relabeling an old request as a new action',() => {
    const f = setup(); f.open().begin(intent)
    expect(f.open().list()).toEqual([expect.objectContaining(intent)])
    expect(f.open('owner','2').read(operationId)?.authorityEpoch).toBe('1')
    expect(() => f.open('owner','2').begin(intent)).toThrow('CONNECTION_VERIFICATION_INVALID')
    f.account('other'); expect(f.open('other').list()).toEqual([])
    expect(() => f.open().begin({ ...intent,operationId: secondId })).toThrow('CONNECTION_ACCOUNT_CHANGED')
  })
  it('blocks a new attempt for the same application and scope without blocking a different device',() => {
    const ledger = setup().open(); ledger.begin(intent)
    expect(() => ledger.begin({ ...intent,operationId: secondId })).toThrow('CONNECTION_APPLICATION_BUSY')
    ledger.begin({ ...intent,operationId: secondId,scopeKey: 'device:two',deviceId: 'two' })
    expect(ledger.list()).toHaveLength(2)
  })
  it('keeps original UNKNOWN and projects only approved result fields without guessing a missing key',() => {
    const f = setup(),ledger = f.open(); ledger.begin(intent)
    ledger.accept(operationId,{ ...status(),credentialGeneration: 'private-generation',evidence: { private: true } } as ConnectionOperationStatus)
    expect(ledger.read(operationId)?.resourceKey).toBeNull()
    expect([...f.rows.values()].join('')).not.toContain('private')
    const succeeded: ConnectionOperationStatus = { ...status(),resourceKey: 'server-key',revision: '8',
      resolution: { outcome: 'applied',resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },effective: { state: 'succeeded',connectionState: 'connected',blocksNewOperations: false },confirmation: { state: 'resolved',deadlineAt: null } }
    ledger.accept(operationId,succeeded); ledger.accept(operationId,status())
    expect(f.open().read(operationId)?.status).toEqual(succeeded)
    expect(f.open().read(operationId)?.status?.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
    expect(() => ledger.accept(operationId,{ ...succeeded,resolution: { outcome: 'failed',resolvedAt: '2026-11-07T00:00:00Z',errorCode: 'CONNECTION_CONFIRMATION_FAILED' } })).toThrow()
  })
  it('persists cancellation intent without changing the original outcome or manufacturing a failure',() => {
    const f = setup(),ledger = f.open(); ledger.begin(intent); ledger.accept(operationId,status()); ledger.requestCancellation(operationId)
    expect(f.open().read(operationId)).toMatchObject({ cancelRequested: true,status: status() })
  })
  it('retains the pre-window presentation through reconstruction and never rewrites an unresolved UNKNOWN original',() => {
    const f = setup(),ledger = f.open(),previous = { state: 'connected' as const,saved: true }
    ledger.begin({ ...intent,previous }); ledger.requestCancellation(operationId); ledger.accept(operationId,status())
    expect(f.open().read(operationId)?.previous).toEqual(previous)
    expect(() => ledger.accept(operationId,{ ...status(),original: { status: 'applied',errorCode: null,terminal: true },
      effective: { state: 'succeeded',connectionState: 'connected',blocksNewOperations: false } })).toThrow('CONNECTION_VERIFICATION_INVALID')
    expect(f.open().read(operationId)?.status?.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
  })
  it('persists only whitelisted pre-window presentation fields',() => {
    const f = setup(); f.open().begin({ ...intent,previous: { state: 'connected',saved: true,credentialGeneration: 'private-generation' } } as Parameters<ReturnType<typeof f.open>['begin']>[0])
    expect([...f.rows.values()].join('')).not.toContain('private-generation')
    expect(f.open().read(operationId)?.previous).toEqual({ state: 'connected',saved: true })
  })
  it('refuses a new authorization when persistence fails, with no in-memory replacement',() => {
    const f = setup(); f.storage.setItem.mockImplementation(() => { throw new Error('QUOTA') })
    expect(() => f.open().begin(intent)).toThrow('QUOTA')
    expect(f.open().list()).toEqual([])
  })
  it('discards only an identity proven unsubmitted and retains a submitted request through reconstruction',() => {
    const f = setup(),ledger = f.open(); ledger.begin(intent); ledger.discardUnsubmitted(operationId)
    expect(ledger.list()).toEqual([])
    ledger.begin(intent); ledger.markSubmitted(operationId)
    expect(() => f.open().discardUnsubmitted(operationId)).toThrow('CONNECTION_VERIFICATION_INVALID')
    expect(f.open().read(operationId)).toMatchObject({ operationId,submitted: true })
  })
  it('blocks a retained action during cancellation and releases it only after an independent result',async () => {
    const ledger = setup().open(); ledger.begin(intent); ledger.requestCancellation(operationId)
    const snapshot = vi.fn(async () => ({ version: 1 as const,state: 'ready' as const,revision: '0',items: [],application: [] }))
    const input = { ownerId: 'owner',accountId: () => 'owner',provider: 'asana',scopeKey: 'device:one',verificationProtocol: 2 as const,verification: ledger,client: { snapshot },changed: vi.fn() }
    await expect(assertConnectionApplicationAvailable(input)).rejects.toMatchObject({ code: 'operation-pending' })
    expect(snapshot).not.toHaveBeenCalled()
    ledger.accept(operationId,{ ...status(),resolution: { outcome: 'applied',resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },
      effective: { state: 'succeeded',connectionState: 'connected',blocksNewOperations: false },confirmation: { state: 'resolved',deadlineAt: null } })
    await expect(assertConnectionApplicationAvailable(input)).resolves.toBeUndefined()
    expect(snapshot).toHaveBeenCalledOnce()
  })
})
