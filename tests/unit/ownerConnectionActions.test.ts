import { beforeEach,describe,expect,it,vi } from 'vitest'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import type { ConnectionClient,NativeConnectionAuthorization } from '@gugu/core/cloud/connections'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { githubAuthSuccessChannel } from '@/session/shared/events/githubEvents'

const fixture = vi.hoisted(() => ({ bridge: {} as Record<string,unknown> }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => fixture.bridge }))
vi.mock('@/lib/platformIntegrations',() => ({ rendererPlatformIntegrationsClient: () => { throw new Error('Unexpected platform authorization') } }))
vi.mock('@/lib/openAuthorizationLink',() => ({ openAuthorizationLink: vi.fn() }))
vi.mock('@/lib/log',() => ({ rendererLogger: () => ({ warn: vi.fn() }) }))
import { ownerConnectionActions } from '@/components/connections/owner-connection-actions'

const operationId = '6c67af58-7190-4c6f-9d49-06d0f6f4865f',ticket = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
const receipt = { operationId,scopeKey: 'device:device',resourceKey: 'original-key',revision: '2',status: 'applied' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise,resolve } }
let route: ConnectionRoute
beforeEach(() => { route = { mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true } })
function setup() {
  const authorization = deferred<{ success: true; account: { accountId: string }; user: { login: string } }>()
  const completion = deferred<typeof receipt>()
  const native = { ownerAuthorizationBegin: vi.fn(async () => {}),ownerAuthorizationComplete: vi.fn(async () => {}),
    ownerAccounts: vi.fn(async () => [{ providerId: 'github',accountId: 'actual',configured: true,publicMetadata: { version: 1,providerId: 'github',accountId: 'actual' } }]),
    ownerAuthorizationCommit: vi.fn((_input: NativeConnectionAuthorization) => completion.promise),ownerAuthorizationCommitBatch: vi.fn() }
  const github = { auth: vi.fn(() => authorization.promise),authCancel: vi.fn(async () => ({ success: true })),onEvent: vi.fn(() => () => {}),
    removeAccount: vi.fn(),setDefaultAccount: vi.fn() }
  const recreateBegin = vi.fn(async () => ({ recreationId: ticket,operationId,expectedItemRevision: null,revision: '0',expiresAt: '2099-01-01T00:00:00Z' }))
  const client = { snapshot: vi.fn(async () => ({ version: 1,state: 'ready',revision: '0',items: [],application: [] })),recreateBegin } as unknown as ConnectionClient
  fixture.bridge = { accountId: () => 'owner',client,routing: createConnectionRouting({ accountId: () => 'owner',read: async () => route,changed: () => {} }) }
  const base = { key: 'actual-device',integrations: native,github } as unknown as LibraryHost
  const host = { ...base,connectionMetadata: { invalidate: vi.fn() },prepareAssistantAction: vi.fn(async () => {}) } as unknown as LibraryHost
  return { actions: ownerConnectionActions(base,host,'device',{ ...route }),native,github,recreateBegin,authorization,completion }
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
  })
  it('never commits or reauthorizes an old-window result after the owner epoch changes', async () => {
    const test = setup(),running = test.actions.github.auth()
    const refused = expect(running).rejects.toMatchObject({ code: 'route-changed' })
    await vi.waitFor(() => expect(test.github.auth).toHaveBeenCalledOnce())
    route = { ...route,epoch: '2' }; test.authorization.resolve(authorized); await refused
    expect(test.native.ownerAuthorizationCommit).not.toHaveBeenCalled()
    expect(test.github.auth).toHaveBeenCalledOnce(); expect(test.recreateBegin).toHaveBeenCalledOnce()
  })
})
