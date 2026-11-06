import { beforeEach,describe,expect,it,vi } from 'vitest'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import type { ConnectionClient,ConnectionSnapshot,ConnectionCommit,NativeConnectionAuthorization } from '@gugu/core/cloud/connections'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { githubAuthSuccessChannel } from '@/session/shared/events/githubEvents'

const fixture = vi.hoisted(() => ({ bridge: {} as Record<string,unknown>,notify: vi.fn(),platform: { saveCredential: vi.fn(),beginOAuth: vi.fn(),list: vi.fn() } }))
vi.mock('@/lib/notices',() => ({ notify: fixture.notify }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => fixture.bridge }))
vi.mock('@/lib/platformIntegrations',() => ({ rendererPlatformIntegrationsClient: () => fixture.platform }))
vi.mock('@/lib/openAuthorizationLink',() => ({ openAuthorizationLink: vi.fn() }))
vi.mock('@/lib/log',() => ({ rendererLogger: () => ({ warn: vi.fn() }) }))
import { assertConnectionApplicationAvailable } from '@/components/connections/connection-action-guard'
import { ownerConnectionActions } from '@/components/connections/owner-connection-actions'

const operationId = '6c67af58-7190-4c6f-9d49-06d0f6f4865f',ticket = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
const receipt = { operationId,scopeKey: 'device:device',resourceKey: 'original-key',revision: '2',status: 'applied' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise,resolve } }
let route: ConnectionRoute
beforeEach(() => { fixture.notify.mockClear(); fixture.platform.saveCredential.mockReset(); fixture.platform.beginOAuth.mockReset(); fixture.platform.list.mockReset(); route = { mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true } })
function setup() {
  const authorization = deferred<{ success: true; account: { accountId: string }; user: { login: string } }>()
  const completion = deferred<typeof receipt>()
  const native = { ownerAuthorizationBegin: vi.fn(async () => {}),ownerAuthorizationComplete: vi.fn(async () => {}),
    ownerAccounts: vi.fn(async () => [{ providerId: 'github',accountId: 'actual',configured: true,publicMetadata: { version: 1,providerId: 'github',accountId: 'actual' } }]),
    ownerAuthorizationCommit: vi.fn((_input: NativeConnectionAuthorization) => completion.promise),ownerAuthorizationCommitBatch: vi.fn(),connect: vi.fn(),authorize: vi.fn(),cliLoginStart: vi.fn(),cliToolPrepare: vi.fn(),cancelAuthorization: vi.fn(async () => {}) }
  const github = { auth: vi.fn(() => authorization.promise),authCancel: vi.fn(async () => ({ success: true })),onEvent: vi.fn(() => () => {}),
    removeAccount: vi.fn(),setDefaultAccount: vi.fn(),importCliAccounts: vi.fn() }
  const recreateBegin = vi.fn<ConnectionClient['recreateBegin']>(async () => ({ recreationId: ticket,operationId,expectedItemRevision: null,revision: '0',expiresAt: '2099-01-01T00:00:00Z' }))
  const snapshot = vi.fn<() => Promise<ConnectionSnapshot>>(async () => ({ version: 1,state: 'ready',revision: '0',items: [],application: [] }))
  const client = { snapshot,recreateBegin,commit: vi.fn(async (change: ConnectionCommit) => ({ operationId: change.operationId,scopeKey: change.scopeKey,resourceKey: change.resourceKey ?? 'resolved-key',revision: '10',status: 'applied' })) } as unknown as ConnectionClient
  fixture.bridge = { accountId: () => 'owner',client,routing: createConnectionRouting({ accountId: () => 'owner',read: async () => route,changed: () => {} }) }
  const base = { key: 'actual-device',integrations: native,github } as unknown as LibraryHost
  const host = { ...base,connectionMetadata: { ownerId: 'owner',invalidate: vi.fn() },prepareAssistantAction: vi.fn(async () => {}) } as unknown as LibraryHost
  return { actions: ownerConnectionActions(base,host,'device',{ ...route }),native,github,recreateBegin,authorization,completion,snapshot }
}
const authorized = { success: true as const,account: { accountId: 'actual' },user: { login: 'person' } }
describe('owner authorization retains the original route and reports only committed success', () => {
  it('holds observations and acquires the ticket before authorization, then delays GitHub success until the native commit', async () => {
    const test = setup(),success = vi.fn()
    test.actions.github.onEvent(githubAuthSuccessChannel,success)
    const running = test.actions.github.auth()
    await vi.waitFor(() => expect(test.github.auth).toHaveBeenCalledWith(true))
    expect(test.native.ownerAuthorizationBegin.mock.invocationCallOrder[0]).toBeLessThan(test.recreateBegin.mock.invocationCallOrder[0]!)
    expect(test.recreateBegin.mock.invocationCallOrder[0]).toBeLessThan(test.github.auth.mock.invocationCallOrder[0]!)
    test.authorization.resolve(authorized)
    await vi.waitFor(() => expect(test.native.ownerAuthorizationCommit).toHaveBeenCalledOnce())
    expect(success).not.toHaveBeenCalled()
    expect(test.native.ownerAuthorizationCommit).toHaveBeenCalledWith(expect.objectContaining({ authorityEpoch: '1',accountId: 'actual',recreationId: ticket }))
    test.completion.resolve({ ...receipt,operationId: test.native.ownerAuthorizationCommit.mock.calls[0]![0].operationId }); await running
    expect(success).toHaveBeenCalledExactlyOnceWith({ user: authorized.user })
  })
  it('retains credentials and refuses a late result after the person cancels without minting another ticket', async () => {
    const test = setup(),running = test.actions.github.auth()
    const refused = expect(running).rejects.toMatchObject({ code: 'intent-changed' })
    await vi.waitFor(() => expect(test.github.auth).toHaveBeenCalledOnce())
    await test.actions.github.authCancel(); test.authorization.resolve(authorized); await refused
    expect(test.native.ownerAuthorizationCommit).not.toHaveBeenCalled()
    expect(test.recreateBegin).toHaveBeenCalledOnce()
    expect(fixture.notify).not.toHaveBeenCalled()
  })
  it('never commits or reauthorizes an old-window result after the owner epoch changes', async () => {
    const test = setup(),running = test.actions.github.auth()
    const refused = expect(running).rejects.toMatchObject({ code: 'route-changed' })
    await vi.waitFor(() => expect(test.github.auth).toHaveBeenCalledOnce())
    route = { ...route,epoch: '2' }; test.authorization.resolve(authorized); await refused
    expect(test.native.ownerAuthorizationCommit).not.toHaveBeenCalled()
    expect(test.github.auth).toHaveBeenCalledOnce(); expect(test.recreateBegin).toHaveBeenCalledOnce()
    expect(fixture.notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error',title: expect.stringMatching(/GitHub/) }))
  })
})

function unknownSnapshot(providerId: string): ConnectionSnapshot {
  const scopeKey = providerId === 'github' ? 'device:device' : 'platform',resourceKey = 'retained-account',deviceId = providerId === 'github' ? 'device' : null
  return { version: 1,state: 'ready',revision: '9',items: [{ scopeKey,resourceKey,deviceId,revision: '9',
    data: { providerId,accountId: 'existing' },publicMetadata: null,document: null,bodySha256: null,deletedAt: '2026-11-07T00:00:00Z',staleAt: null,observedAt: null,updatedAt: '2026-11-07T00:00:00Z' }],
  application: [{ operationId,requestHash: 'a'.repeat(64),scopeKey,resourceKey,deviceId,revision: '9',expectedItemRevision: '8',operation: 'save',
    status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true,admissionId: ticket,startedAt: '2026-11-07T00:00:00Z' }] }
}
it.each(['platform-form','platform-oauth','native-form','native-oauth','native-cli','native-prepare','github-auth','github-import'] as const)(
  'blocks a retained %s action when its latest application becomes UNKNOWN before submit',async kind => {
    const test = setup(),provider = kind.startsWith('platform') ? kind === 'platform-oauth' ? 'baidu-pan' : 'amap' : 'github'
    // Construct while healthy, as an already-open dialog does; never rely on its stale disabled state.
    const submit = kind === 'platform-form' || kind === 'native-form' ? () => test.actions.integrations.connect(provider,{ apiKey: 'synthetic' })
      : kind === 'platform-oauth' || kind === 'native-oauth' ? () => test.actions.integrations.authorize(provider)
        : kind === 'native-cli' ? () => test.actions.integrations.cliLoginStart(provider)
          : kind === 'native-prepare' ? () => test.actions.integrations.cliToolPrepare(provider)
          : kind === 'github-import' ? () => test.actions.github.importCliAccounts() : () => test.actions.github.auth()
    test.authorization.resolve(authorized); test.completion.resolve(receipt)
    test.snapshot.mockResolvedValue(unknownSnapshot(provider))
    await expect(submit()).rejects.toMatchObject({ code: 'outcome-unknown' })
    expect(test.recreateBegin).not.toHaveBeenCalled()
    expect(test.native.ownerAuthorizationBegin).not.toHaveBeenCalled()
    for (const effect of [fixture.platform.saveCredential,fixture.platform.beginOAuth,test.native.connect,test.native.authorize,test.native.cliLoginStart,test.native.cliToolPrepare,test.github.auth,test.github.importCliAccounts])
      expect(effect).not.toHaveBeenCalled()
    expect(fixture.notify).not.toHaveBeenCalled()
  })
it('rechecks after the intent response before allowing a credential effect',async () => {
  const test = setup(),pending = deferred<Awaited<ReturnType<ConnectionClient['recreateBegin']>>>()
  test.recreateBegin.mockImplementation(() => pending.promise)
  const running = test.actions.integrations.connect('amap',{ apiKey: 'synthetic' })
  const refused = expect(running).rejects.toMatchObject({ code: 'outcome-unknown' })
  await vi.waitFor(() => expect(test.recreateBegin).toHaveBeenCalledOnce())
  test.snapshot.mockResolvedValue(unknownSnapshot('amap'))
  pending.resolve({ recreationId: ticket,operationId,expectedItemRevision: null,revision: '0',expiresAt: '2099-01-01T00:00:00Z' })
  await refused
  expect(fixture.platform.saveCredential).not.toHaveBeenCalled()
  expect(test.recreateBegin).toHaveBeenCalledOnce()
})

it('keeps unrelated applications usable and allows new-owner initialization before its first effect',async () => {
  const test = setup()
  fixture.platform.saveCredential.mockResolvedValue({})
  fixture.platform.list.mockResolvedValue([{ provider: 'amap',accounts: [{ accountId: 'default',connected: true,updatedAt: '2026-11-07T00:00:00Z' }] }])
  test.snapshot.mockResolvedValue(unknownSnapshot('github'))
  await expect(test.actions.integrations.connect('amap',{ apiKey: 'synthetic' })).resolves.toEqual({ success: true })
  expect(fixture.platform.saveCredential).toHaveBeenCalledOnce()
  test.snapshot.mockResolvedValue({ version: 1,state: 'not-ready',revision: '0',items: null,application: null })
  test.recreateBegin.mockImplementation(async () => {
    test.snapshot.mockResolvedValue({ version: 1,state: 'ready',revision: '1',items: [],application: [] })
    return { recreationId: ticket,operationId,expectedItemRevision: null,revision: '1',expiresAt: '2099-01-01T00:00:00Z' }
  })
  await expect(test.actions.integrations.connect('amap',{ apiKey: 'synthetic' })).resolves.toEqual({ success: true })
  expect(fixture.platform.saveCredential).toHaveBeenCalledTimes(2)
})
it('rejects unresolved pending work as a new action but leaves cancellation available',async () => {
  const test = setup(),snapshot = unknownSnapshot('github')
  snapshot.application![0]!.status = 'pending'; snapshot.application![0]!.terminal = false; snapshot.application![0]!.errorCode = null
  test.snapshot.mockResolvedValue(snapshot)
  await expect(test.actions.github.auth()).rejects.toMatchObject({ code: 'operation-pending' })
  expect(test.recreateBegin).not.toHaveBeenCalled(); expect(test.github.auth).not.toHaveBeenCalled()
  await test.actions.github.authCancel()
  await test.actions.integrations.cancelAuthorization('github')
  expect(test.github.authCancel).toHaveBeenCalledOnce(); expect(test.native.cancelAuthorization).toHaveBeenCalledOnce()
  expect(fixture.notify).not.toHaveBeenCalled()
})
it('does not treat a failed status read as permission to start an authorization',async () => {
  const test = setup()
  test.snapshot.mockRejectedValue(Object.assign(new Error('OFFLINE'),{ code: 'read-timeout' }))
  await expect(test.actions.integrations.connect('amap',{ apiKey: 'synthetic' })).rejects.toMatchObject({ code: 'read-timeout' })
  expect(test.recreateBegin).not.toHaveBeenCalled(); expect(fixture.platform.saveCredential).not.toHaveBeenCalled()
})

it('permits identical pending metadata receipts without allowing an UNKNOWN effect to replay',async () => {
  const test=setup(),snapshot=unknownSnapshot('github'),input={ownerId:'owner',accountId:()=> 'owner',client:{snapshot:test.snapshot},provider:'github',scopeKey:'device:device',operationIds:[operationId],changed:vi.fn()}
  snapshot.application![0]!.status='pending';snapshot.application![0]!.terminal=false;snapshot.application![0]!.errorCode=null
  test.snapshot.mockResolvedValue(snapshot)
  await expect(assertConnectionApplicationAvailable(input)).resolves.toBeUndefined()
  await expect(assertConnectionApplicationAvailable({...input,operationIds:undefined})).rejects.toMatchObject({code:'operation-pending'})
  snapshot.application![0]!.status='failed';snapshot.application![0]!.terminal=true;snapshot.application![0]!.errorCode='CONNECTION_OUTCOME_UNKNOWN'
  await expect(assertConnectionApplicationAvailable(input)).rejects.toMatchObject({code:'outcome-unknown'})
})

it('rejects a retained action from a previous owner before reading or writing another account',async () => {
  const test=setup();fixture.bridge.accountId=()=> 'other-owner'
  await expect(test.actions.integrations.connect('amap',{apiKey:'synthetic'})).rejects.toMatchObject({code:'account-changed'})
  expect(test.snapshot).not.toHaveBeenCalled();expect(test.recreateBegin).not.toHaveBeenCalled()
  expect(fixture.platform.saveCredential).not.toHaveBeenCalled();expect(fixture.notify).not.toHaveBeenCalled()
})

it('keeps a same-named application on another device outside the selected action scope',async () => {
  const test=setup();test.snapshot.mockResolvedValue(unknownSnapshot('github'))
  await expect(assertConnectionApplicationAvailable({ownerId:'owner',accountId:()=> 'owner',client:{snapshot:test.snapshot},
    provider:'github',scopeKey:'device:other',requireReady:true,changed:vi.fn()})).resolves.toBeUndefined()
})
