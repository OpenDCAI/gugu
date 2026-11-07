import { beforeEach,expect,it,vi } from 'vitest'
import { createConnectionRouting } from '@gugu/core/cloud/connectionRouting'
import type { ConnectionClient,ConnectionSnapshot,NativeConnectionAuthorization } from '@gugu/core/cloud/connections'
import type { ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { createConnectionVerification } from '@/components/connections/connection-verification'

const fixture = vi.hoisted(() => ({ bridge: {} as Record<string,unknown>,notify: vi.fn(),link: vi.fn(),platform: {
  connectOperation: vi.fn(),beginOAuthOperation: vi.fn(),cancelOperation: vi.fn(),saveCredential: vi.fn(),list: vi.fn(),cancelOAuth: vi.fn(),
} }))
vi.mock('@/lib/notices',() => ({ notify: fixture.notify }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => fixture.bridge }))
vi.mock('@/lib/platformIntegrations',() => ({ rendererPlatformIntegrationsClient: () => fixture.platform }))
vi.mock('@/lib/openAuthorizationLink',() => ({ openAuthorizationLink: fixture.link }))
vi.mock('@/lib/log',() => ({ rendererLogger: () => ({ warn: vi.fn() }) }))
import { ownerConnectionActions } from '@/components/connections/owner-connection-actions'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise,resolve } }
const route = { mode: 'owner' as const,epoch: '1',phase: 'stable' as const,acceptingNewOperations: true,verificationProtocol: 2 as const }
const ticket = '20000000-0000-4000-8000-000000000001'
function setup() {
  let account = 'owner'
  const rows = new Map<string,string>(),order: string[] = []
  const storage = { get length() { return rows.size },key: (index: number) => [...rows.keys()][index] ?? null,getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string,value: string) => { rows.set(key,value) },removeItem: (key: string) => { rows.delete(key) } }
  const ledger = createConnectionVerification({ ownerId: 'owner',epoch: '1',accountId: () => account,storage,changed: vi.fn() })
  const status = (operationId: string,scopeKey = 'device:one',state: 'confirming' | 'succeeded' | 'cancelled' = 'succeeded'): ConnectionOperationStatus => ({ version: 1,operationId,scopeKey,resourceKey: 'server-key',deviceId: scopeKey === 'platform' ? null : 'one',revision: '4',operation: 'save',
    original: { status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true },resolution: state === 'confirming' ? null : { outcome: state === 'succeeded' ? 'applied' : 'cancelled',resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },
    effective: { state,connectionState: state === 'succeeded' ? 'connected' : state === 'cancelled' ? 'disconnected' : 'confirming',blocksNewOperations: state === 'confirming' },confirmation: { state: state === 'confirming' ? 'pending' : 'resolved',deadlineAt: null,cancelRequested: state === 'cancelled' } })
  const client = { snapshot: vi.fn(async () => ({ version: 1,state: 'ready',revision: '0',items: [],application: [] })),
    recreateBegin: vi.fn(async (value: { operationId: string }) => { order.push('intent'); expect(ledger.read(value.operationId)).toBeDefined(); return { recreationId: ticket,operationId: value.operationId,revision: '1',expectedItemRevision: null,expiresAt: '2099-01-01T00:00:00Z' } }),
    operationStatus: vi.fn(async (operationId: string) => status(operationId)),
    cancelAuthorization: vi.fn(async (_id: string): Promise<ConnectionOperationStatus | null> => null),commit: vi.fn() } as unknown as ConnectionClient
  const native = { ownerAuthorizationBegin: vi.fn(async () => { order.push('hold') }),ownerAuthorizationPrepare: vi.fn(async () => { order.push('prepare') }),
    ownerConnect: vi.fn(async () => { order.push('effect'); return { success: true,accountId: 'actual' } }),ownerAuthorize: vi.fn(async () => ({ success: true,accountId: 'actual' })),
    ownerAuthorizationCommit: vi.fn(async (value: NativeConnectionAuthorization) => { order.push('commit'); return { operationId: value.operationId,scopeKey: 'device:one',resourceKey: 'server-key',revision: '4',status: 'applied' } }),
    ownerAuthorizationComplete: vi.fn(async () => { order.push('release') }),ownerAccounts: vi.fn(),connect: vi.fn(),authorize: vi.fn(),cancelAuthorization: vi.fn() }
  fixture.bridge = { accountId: () => account,client,routing: createConnectionRouting({ accountId: () => account,read: async () => route,changed: () => {} }) }
  const base = { key: 'device',integrations: native,github: { setDefaultAccount: vi.fn(),removeAccount: vi.fn(),onEvent: vi.fn() } } as unknown as LibraryHost
  const host = { ...base,connectionMetadata: { ownerId: 'owner',verificationProtocol: 2,verification: ledger,invalidate: vi.fn() },prepareAssistantAction: vi.fn(async () => {}) } as unknown as LibraryHost
  return { actions: ownerConnectionActions(base,host,'one',route),native,client,ledger,order,status,account: (next: string) => { account = next } }
}
beforeEach(() => { vi.resetAllMocks() })
it('uses hold, intent, prepare, managed native effect and frozen native commit in order without reconstructing accounts',async () => {
  const f = setup()
  expect(f.actions.canAuthorizeConnection?.('asana')).toBe(true)
  await expect(f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })).resolves.toMatchObject({ success: true })
  expect(f.order).toEqual(['hold','intent','prepare','effect','commit','release'])
  const id = f.native.ownerAuthorizationCommit.mock.calls[0]![0].operationId
  expect(f.native.ownerConnect).toHaveBeenCalledWith('asana',id,'1',{ apiKey: 'synthetic' },undefined)
  expect(f.native.ownerAuthorizationCommit).toHaveBeenCalledWith(expect.objectContaining({ operationId: id,accountId: 'actual',recreationId: ticket,authorityEpoch: '1' }))
  expect(f.client.operationStatus).toHaveBeenCalledWith(id); expect(f.ledger.read(id)?.status?.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
  expect(f.native.connect).not.toHaveBeenCalled(); expect(f.native.ownerAccounts).not.toHaveBeenCalled(); expect(f.client.commit).not.toHaveBeenCalled()
})
it('uses the original managed platform UUID once, with no plain credential write or renderer metadata reconstruction',async () => {
  const f = setup()
  fixture.platform.connectOperation.mockImplementation(async (_provider,id) => ({ operationId: id,scopeKey: 'platform',resourceKey: 'server-key',revision: '4',status: 'applied' }))
  vi.mocked(f.client.operationStatus).mockImplementation(async id => f.status(id,'platform'))
  await expect(f.actions.integrations.connect('amap',{ apiKey: 'synthetic' })).resolves.toMatchObject({ success: true })
  const id = fixture.platform.connectOperation.mock.calls[0]![1]
  expect(fixture.platform.connectOperation).toHaveBeenCalledWith('amap',id,'1',{ apiKey: 'synthetic' })
  expect(f.ledger.read(id)).toMatchObject({ operationId: id,scopeKey: 'platform',deviceId: null })
  for (const effect of [fixture.platform.saveCredential,fixture.platform.list,f.client.commit,f.native.ownerConnect]) expect(effect).not.toHaveBeenCalled()
})
it('uses managed native browser authorization and the original frozen commit rather than a provider-only browser call',async () => {
  const f = setup()
  expect(f.actions.canAuthorizeConnection?.('notion')).toBe(true)
  await expect(f.actions.integrations.authorize('notion')).resolves.toMatchObject({ success: true })
  const id = f.ledger.list()[0]!.operationId
  expect(f.native.ownerAuthorize).toHaveBeenCalledWith('notion',id,'1'); expect(f.native.authorize).not.toHaveBeenCalled()
  expect(f.native.ownerAuthorizationCommit).toHaveBeenCalledWith(expect.objectContaining({ operationId: id,providerId: 'notion',accountId: 'actual' }))
})
it('opens only the original platform OAuth URL and polls its UUID without borrowing legacy OAuth status or cancellation',async () => {
  const f = setup()
  fixture.platform.beginOAuthOperation.mockImplementation(async (_provider,id) => ({ operationId: id,authorizationUrl: 'https://authorization.example/approved',expiresAt: Date.now() + 1000 }))
  vi.mocked(f.client.operationStatus).mockImplementation(async id => f.status(id,'platform'))
  await expect(f.actions.integrations.authorize('baidu-pan')).resolves.toMatchObject({ success: true })
  const id = f.ledger.list()[0]!.operationId
  expect(fixture.platform.beginOAuthOperation).toHaveBeenCalledExactlyOnceWith('baidu-pan',id,'1')
  expect(fixture.link).toHaveBeenCalledExactlyOnceWith('https://authorization.example/approved')
  expect(f.client.operationStatus).toHaveBeenCalledWith(id); expect(fixture.platform.cancelOAuth).not.toHaveBeenCalled()
})
it('closes quietly during a delayed native prepare, preserves the original UUID and never starts a late effect',async () => {
  const f = setup(),prepare = deferred<void>()
  f.native.ownerAuthorizationPrepare.mockImplementation(() => prepare.promise)
  vi.mocked(f.client.operationStatus).mockResolvedValue(null)
  const running = f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ cancelled: true })
  await vi.waitFor(() => expect(f.native.ownerAuthorizationPrepare).toHaveBeenCalledOnce())
  const cancelling = f.actions.integrations.cancelAuthorization('asana')
  expect(f.ledger.list()[0]).toMatchObject({ cancelRequested: true })
  prepare.resolve(); await cancelling; await refused
  const id = f.ledger.list()[0]!.operationId
  expect(f.client.cancelAuthorization).toHaveBeenCalledWith(id); expect(f.native.ownerAuthorizationComplete).toHaveBeenCalledWith('asana',id)
  expect(f.native.ownerConnect).not.toHaveBeenCalled(); expect(f.native.connect).not.toHaveBeenCalled(); expect(f.native.cancelAuthorization).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
it('keeps a NULL cancellation reply pending when recreation arrives late and never prepares or executes that authorization',async () => {
  const f = setup(),ticketReply = deferred<Awaited<ReturnType<ConnectionClient['recreateBegin']>>>()
  vi.mocked(f.client.recreateBegin).mockImplementation(() => ticketReply.promise)
  vi.mocked(f.client.operationStatus).mockResolvedValue(null)
  const running = f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ cancelled: true })
  await vi.waitFor(() => expect(f.client.recreateBegin).toHaveBeenCalledOnce())
  const id = f.ledger.list()[0]!.operationId,cancelling = f.actions.integrations.cancelAuthorization('asana')
  ticketReply.resolve({ recreationId: ticket,operationId: id,revision: '1',expectedItemRevision: null,expiresAt: '2099-01-01T00:00:00Z' })
  await cancelling; await refused
  expect(f.ledger.read(id)).toMatchObject({ cancelRequested: true,submitted: true })
  expect(f.ledger.read(id)?.status).toBeUndefined(); expect(f.native.ownerAuthorizationPrepare).not.toHaveBeenCalled(); expect(f.native.ownerConnect).not.toHaveBeenCalled()
  expect(f.client.cancelAuthorization).toHaveBeenCalledWith(id); expect(fixture.notify).not.toHaveBeenCalled()
})
it('does not dispatch recreation after the dialog closes while its initial metadata is being read',async () => {
  const f = setup(),read = deferred<Awaited<ReturnType<ConnectionClient['snapshot']>>>()
  const ready = { version: 1 as const,state: 'ready' as const,revision: '0',items: [],application: [] }
  vi.mocked(f.client.snapshot).mockResolvedValueOnce(ready).mockResolvedValueOnce(ready).mockImplementation(() => read.promise)
  const running = f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ cancelled: true })
  await vi.waitFor(() => expect(f.client.snapshot).toHaveBeenCalledTimes(3))
  const cancelling = f.actions.integrations.cancelAuthorization('asana')
  read.resolve(ready); await cancelling; await refused
  expect(f.client.recreateBegin).not.toHaveBeenCalled(); expect(f.native.ownerAuthorizationPrepare).not.toHaveBeenCalled(); expect(f.native.ownerConnect).not.toHaveBeenCalled()
  expect(f.ledger.list()).toEqual([]); expect(fixture.notify).not.toHaveBeenCalled()
})
it('observes an original platform request after its effect response is lost without resending credentials',async () => {
  const f = setup()
  fixture.platform.connectOperation.mockRejectedValue(Object.assign(new Error('LOST_RESPONSE'),{ code: '503' }))
  vi.mocked(f.client.operationStatus).mockImplementation(async id => f.status(id,'platform'))
  await expect(f.actions.integrations.connect('amap',{ apiKey: 'synthetic' })).resolves.toMatchObject({ success: true })
  expect(fixture.platform.connectOperation).toHaveBeenCalledOnce(); expect(f.client.recreateBegin).toHaveBeenCalledOnce(); expect(fixture.platform.saveCredential).not.toHaveBeenCalled()
  expect(fixture.notify).not.toHaveBeenCalled()
})
it('uses successful native proof after losing the commit response without reading another account list or repeating the effect',async () => {
  const f = setup(); f.native.ownerAuthorizationCommit.mockRejectedValue(Object.assign(new Error('LOST_RESPONSE'),{ code: '503' }))
  await expect(f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })).resolves.toMatchObject({ success: true })
  expect(f.native.ownerConnect).toHaveBeenCalledOnce(); expect(f.native.ownerAuthorizationCommit).toHaveBeenCalledOnce()
  expect(f.native.ownerAccounts).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
it('lets successful evidence win over a window close without a success or failure notification',async () => {
  const f = setup(),effect = deferred<{ operationId: string;state: 'confirming' }>()
  fixture.platform.connectOperation.mockImplementation(() => effect.promise)
  fixture.platform.cancelOperation.mockImplementation(async id => f.status(id,'platform'))
  const running = f.actions.integrations.connect('amap',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ cancelled: true })
  await vi.waitFor(() => expect(fixture.platform.connectOperation).toHaveBeenCalledOnce())
  const id = f.ledger.list()[0]!.operationId
  await f.actions.integrations.cancelAuthorization('amap'); await refused
  effect.resolve({ operationId: id,state: 'confirming' })
  await vi.waitFor(() => expect(f.ledger.read(id)?.status?.effective.state).toBe('succeeded'))
  expect(f.ledger.read(id)?.status?.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
  expect(fixture.platform.cancelOperation).toHaveBeenCalledWith(id); expect(fixture.platform.cancelOAuth).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
it('refuses a late producer response after the owner changes without notifying or querying the other owner',async () => {
  const f = setup(),effect = deferred<{ operationId: string;state: 'confirming' }>()
  fixture.platform.connectOperation.mockImplementation(() => effect.promise)
  const running = f.actions.integrations.connect('amap',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ code: 'account-changed' })
  await vi.waitFor(() => expect(fixture.platform.connectOperation).toHaveBeenCalledOnce())
  const id = f.ledger.list()[0]!.operationId; f.account('other'); effect.resolve({ operationId: id,state: 'confirming' }); await refused
  expect(f.client.operationStatus).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
it('treats an explicit managed producer AbortError as cancellation instead of turning its later failed status into a failure notice',async () => {
  const f = setup(); f.native.ownerConnect.mockRejectedValue(new DOMException('User closed authorization','AbortError'))
  vi.mocked(f.client.operationStatus).mockImplementation(async id => ({ ...f.status(id),resolution: { outcome: 'failed',resolvedAt: '2026-11-07T00:00:00Z',errorCode: 'CONNECTION_CONFIRMATION_FAILED' },
    effective: { state: 'failed',connectionState: 'failed',blocksNewOperations: false } }))
  await expect(f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })).rejects.toMatchObject({ cancelled: true })
  expect(f.ledger.list()[0]).toMatchObject({ cancelRequested: true })
  expect(f.native.ownerAuthorizationCommit).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
it('reports a verified user-operation failure once through the named unified notice',async () => {
  const f = setup(); f.native.ownerConnect.mockRejectedValue(Object.assign(new Error('private upstream diagnostic'),{ knownNoEffect: true }))
  vi.mocked(f.client.operationStatus).mockImplementation(async id => ({ ...f.status(id),resolution: { outcome: 'failed',resolvedAt: '2026-11-07T00:00:00Z',errorCode: 'CONNECTION_CONFIRMATION_FAILED' },
    effective: { state: 'failed',connectionState: 'failed',blocksNewOperations: false } }))
  await expect(f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })).rejects.toMatchObject({ code: 'authorization-failed' })
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tier: 'error',title: 'Asana没连上，请重新授权。' }))
  expect(f.native.ownerConnect).toHaveBeenCalledOnce(); expect(f.native.ownerAuthorizationCommit).not.toHaveBeenCalled()
})
it('rechecks a newly UNKNOWN application after preparation before allowing a managed credential effect',async () => {
  const f = setup(),otherId = '30000000-0000-4000-8000-000000000001'
  const unknown: ConnectionSnapshot = { version: 1,state: 'ready',revision: '9',items: [{ scopeKey: 'device:one',resourceKey: 'existing-key',deviceId: 'one',revision: '9',
    data: { providerId: 'asana',accountId: 'existing' },publicMetadata: null,document: null,bodySha256: null,deletedAt: null,staleAt: null,observedAt: null,updatedAt: 'now' }],
    application: [{ operationId: otherId,requestHash: 'a'.repeat(64),scopeKey: 'device:one',resourceKey: 'existing-key',deviceId: 'one',revision: '9',expectedItemRevision: '8',operation: 'save',
      status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true,admissionId: ticket,startedAt: 'now' }] }
  f.native.ownerAuthorizationPrepare.mockImplementation(async () => { vi.mocked(f.client.snapshot).mockResolvedValue(unknown) })
  await expect(f.actions.integrations.connect('asana',{ apiKey: 'synthetic' })).rejects.toMatchObject({ code: 'outcome-unknown' })
  expect(f.native.ownerConnect).not.toHaveBeenCalled(); expect(f.native.connect).not.toHaveBeenCalled(); expect(f.native.ownerAuthorizationCommit).not.toHaveBeenCalled()
  expect(fixture.notify).not.toHaveBeenCalled()
})
it('keeps the first pending attempt cancellable when two submissions race before its durable identity is written',async () => {
  const f = setup(),hold = deferred<void>()
  f.native.ownerAuthorizationBegin.mockImplementation(() => hold.promise)
  const running = f.actions.integrations.connect('asana',{ apiKey: 'synthetic' }).then(value => ({ value,error: undefined }),error => ({ value: undefined,error }))
  const duplicate = f.actions.integrations.connect('asana',{ apiKey: 'synthetic' }).catch(error => error)
  await vi.waitFor(() => expect(f.native.ownerAuthorizationBegin).toHaveBeenCalledOnce())
  const rejected = await duplicate
  expect(rejected).toMatchObject({ code: 'operation-pending' })
  const cancelling = f.actions.integrations.cancelAuthorization('asana'); hold.resolve(); await cancelling
  expect((await running).error).toMatchObject({ cancelled: true })
  expect(f.client.recreateBegin).not.toHaveBeenCalled(); expect(f.native.ownerConnect).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled()
})
