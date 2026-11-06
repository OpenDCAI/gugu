import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionRuntime } from '../../apps/desktop/electron/sessionpage/connection-runtime'

const { rpc,authority } = vi.hoisted(() => ({ rpc: vi.fn(),authority: vi.fn() }))
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc: (name: string,args: Record<string,unknown>) => ({ abortSignal: () => name === 'connection_authority' ? authority() : rpc(name,args) }) }) }))
const operationId = '6c67af58-7190-4c6f-9d49-06d0f6f4865f',admissionId = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17',requestHash = 'a'.repeat(64)
const change = { operationId,requestHash,scopeKey: 'device:device',resourceKey: 'imported-original-key',deviceId: 'device',revision: '5',expectedItemRevision: '4',
  operation: 'remove',payload: { before: { providerId: 'github',accountId: 'account' } },status: 'pending',errorCode: null,terminal: false,admissionId: null,startedAt: null }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(),'connection-runtime-')); rpc.mockReset(); authority.mockReset()
  authority.mockResolvedValue({ data: { version: 1,mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true },error: null }) })
afterEach(async () => { await rm(root,{ recursive: true,force: true }) })
function setup() {
  const applyConnection = vi.fn(async () => {})
  const runtime = () => createConnectionRuntime({ guguHome: root,getAuth: async () => ({ userId: 'owner',accessToken: 'fixture' }),
    deviceId: async () => 'device',instanceId: () => 'runtime',local: { applyConnection } })
  return { applyConnection,runtime }
}
const answer = (data: unknown) => ({ data,error: null })

describe('owner connection runtime', () => {
  it('does not call closed owner APIs or consume effects while the explicit mode is legacy', async () => {
    authority.mockResolvedValue(answer({ version: 1,mode: 'legacy',epoch: '0',phase: 'stable',acceptingNewOperations: true }))
    rpc.mockRejectedValue(Object.assign(new Error('CLOSED'),{ code: '42501' }))
    const { runtime,applyConnection } = setup(),worker = runtime()
    await worker.prepare()
    expect(rpc).not.toHaveBeenCalled(); expect(applyConnection).not.toHaveBeenCalled()
    await expect(worker.hold('github',operationId)).rejects.toMatchObject({ code: 'route-changed' })
    expect(rpc).not.toHaveBeenCalled(); worker.dispose()
  })
  it('does not infer legacy from a failed authority read or start new work while quiescing', async () => {
    const { runtime,applyConnection } = setup(),worker = runtime()
    authority.mockResolvedValueOnce({ data: null,error: { code: '42501',message: 'DENIED' } })
    await expect(worker.prepare()).rejects.toMatchObject({ code: '42501' })
    authority.mockResolvedValueOnce(answer({ version: 1,mode: 'owner',epoch: '1',phase: 'quiescing',acceptingNewOperations: false }))
    await expect(worker.prepare()).rejects.toMatchObject({ code: 'quiescing' })
    expect(rpc).not.toHaveBeenCalled(); expect(applyConnection).not.toHaveBeenCalled(); worker.dispose()
  })
  it('leaves existing connections alone while owner authority is not ready', async () => {
    const { runtime,applyConnection } = setup()
    rpc.mockResolvedValue(answer({ version: 1,state: 'not-ready',revision: '0',items: [],application: [] }))
    await runtime().prepare()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('connection_snapshot',{ p_device_id: 'device' })
    expect(applyConnection).not.toHaveBeenCalled()
  })
  it('applies an imported operation once and resends its persisted completion after restart', async () => {
    const { runtime,applyConnection } = setup()
    let loseAck = true
    rpc.mockImplementation(async (name: string,args: Record<string,unknown>) => {
      if (name === 'connection_snapshot') return answer({ version: 1,state: 'ready',revision: '5',items: [],application: [] })
      if (name === 'connection_pending') return answer({ version: 1,revision: '5',changes: [change] })
      if (name === 'connection_admit') return args.p_operation_id
        ? answer({ admitted: true,revision: '5',operationId,operationRevision: '5',requestHash,admissionId })
        : answer({ admitted: true,revision: '6' })
      if (name === 'connection_ack') {
        if (loseAck) { loseAck = false; throw new Error('ACK_RESPONSE_LOST') }
        return answer({ operationId,admissionId,revision: '6',status: 'applied',errorCode: null,terminal: false })
      }
      throw new Error(`Unexpected ${name}`)
    })
    const first = runtime()
    await expect(first.prepare()).rejects.toMatchObject({ code: 'transport-failed' })
    first.dispose()
    await runtime().prepare()
    expect(applyConnection).toHaveBeenCalledExactlyOnceWith({ operation: 'remove',data: change.payload.before })
    expect(rpc.mock.calls.filter(([name,args]) => name === 'connection_admit' && args.p_operation_id)).toHaveLength(1)
    expect(rpc.mock.calls.filter(([name]) => name === 'connection_ack').map(([,args]) => [args.p_operation_id,args.p_admission_id,args.p_error_code])).toEqual([
      [operationId,admissionId,null],[operationId,admissionId,null],
    ])
  })
  it('reports a server-side started operation without replay when no completion exists locally', async () => {
    const { runtime,applyConnection } = setup()
    rpc.mockImplementation(async (name: string) => {
      if (name === 'connection_snapshot') return answer({ version: 1,state: 'ready',revision: '5',items: [],application: [] })
      if (name === 'connection_pending') return answer({ version: 1,revision: '5',changes: [{ ...change,status: 'started',admissionId,startedAt: '2026-11-07T00:00:00Z' }] })
      if (name === 'connection_ack') return answer({ operationId,admissionId,revision: '6',status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true })
      throw new Error(`Unexpected ${name}`)
    })
    await expect(runtime().prepare()).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    expect(applyConnection).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenLastCalledWith('connection_ack',expect.objectContaining({ p_operation_id: operationId,p_admission_id: admissionId,p_terminal: true }))
  })
  it('keeps unresolved terminal outcomes out of new task admission', async () => {
    const { runtime,applyConnection } = setup()
    rpc.mockResolvedValue(answer({ version: 1,state: 'ready',revision: '5',items: [],application: [{ ...change,payload: undefined,
      status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true,admissionId,startedAt: '2026-11-07T00:00:00Z' }] }))
    await expect(runtime().prepare()).rejects.toMatchObject({ code: 'CONNECTION_OUTCOME_UNKNOWN' })
    expect(applyConnection).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('commits authorization from actual native metadata with a runtime and persists the original request across restart', async () => {
    const intent = { authorityEpoch: '1',operationId,recreationId: admissionId,scopeKey: 'device:device',resourceKey: null,expectedRevision: null,providerId: 'github',accountId: 'actual' }
    let updatedAt = 1
    const integrations = vi.fn(async () => [{ providerId: 'github',accountId: 'actual',configured: true as const,isDefault: true,displayName: 'person',
      publicMetadata: { version: 1,providerId: 'github',accountId: 'actual',updatedAt,connectedAt: 1,isDefault: true,
        host: undefined,login: 'person',avatarUrl: undefined,credentialSource: undefined,displayName: undefined } }])
    const runtime = () => createConnectionRuntime({ guguHome: root,getAuth: async () => ({ userId: 'owner',accessToken: 'fixture' }),
      deviceId: async () => 'device',instanceId: () => 'actual-runtime',local: { applyConnection: async () => {},integrations } })
    rpc.mockRejectedValueOnce(new Error('RESPONSE_LOST')).mockImplementation(async (_name,args) => answer({ operationId,scopeKey: 'device:device',
      resourceKey: 'server-resolved',revision: '8',status: 'applied',...args.p_data }))
    const first = runtime()
    await expect(first.commitAuthorization(intent)).rejects.toMatchObject({ code: 'transport-failed' })
    first.dispose(); updatedAt = 2
    const second = runtime()
    await second.commitAuthorization(intent)
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1])
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_runtime_instance_id: 'actual-runtime',p_document: expect.stringContaining('"updatedAt":1') })
    expect(integrations).toHaveBeenCalledTimes(1)
    await expect(second.commitAuthorization({ ...intent,scopeKey: 'device:other' })).rejects.toMatchObject({ code: '42501' })
    authority.mockResolvedValue(answer({ version: 1,mode: 'owner',epoch: '2',phase: 'stable',acceptingNewOperations: true }))
    await expect(second.commitAuthorization(intent)).rejects.toMatchObject({ code: 'route-changed' })
    expect(integrations).toHaveBeenCalledTimes(1)
  })
})
