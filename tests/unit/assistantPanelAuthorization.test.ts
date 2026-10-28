import { readAssistantPanelIntegrations } from '../../apps/desktop/src/components/assistant/assistant-panel-integrations'
import { expect, it, vi } from 'vitest'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { LibraryHost } from '../../apps/desktop/src/session/renderer/features/library/library-host'
import { assistantPanelLibraryHost } from '../../apps/desktop/src/components/assistant/assistant-panel-library-host'

function fixture() {
  const native = vi.fn(async () => ({ success: true })), subscribe = vi.fn(() => vi.fn()), ready = vi.fn(async () => ({}))
  const wait = vi.fn(async () => ({ status: 'pending' }))
  const base = { key: 'native',remote: { online: false },
    integrations: { connect: native,authorize: native,cliLoginStart: native,cliToolPrepare: native,cliLoginWait: wait,cliLoginProgress: native,cancelAuthorization: native,
      list: native,accounts: native,checkAllConnections: native,checkConfiguredConnections: ready },
    github: { auth: native,authCancel: native,listAccounts: native,importCliAccounts: native,onEvent: subscribe },
  } as unknown as LibraryHost
  const panel = { ownerId: 'owner',assistantId: 'assistant',assertCurrent: vi.fn(async () => {}),
    collection: vi.fn(async () => []),snapshot: vi.fn(async () => ({ application: [] })),body: vi.fn(),change: vi.fn(),save: vi.fn(),
  } as unknown as AssistantPanelFiles
  const prepare = vi.fn(async (_signal?: AbortSignal) => {})
  return { native,wait,subscribe,panel,prepare,ready,host: assistantPanelLibraryHost(base,panel,prepare) }
}

it.each(['server_outdated', 'client_outdated', 'forbidden', 'unauthorized'])('preserves %s from the rejecting control layer without starting authorization', async code => {
  const f = fixture()
  const refusal = Object.assign(new Error('The cloud host needs an update'), { code })
  f.ready.mockRejectedValue(refusal)
  await expect(f.host.integrations.cliToolPrepare('feishu')).rejects.toBe(refusal)
  expect(f.ready).toHaveBeenCalledOnce()
  expect(f.native).not.toHaveBeenCalled()
})

it('does not start a CLI download/login until control RPC actually acknowledges the read', async () => {
  const f = fixture()
  let release!: () => void
  f.ready.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}) }))
  const login = f.host.integrations.cliLoginStart('feishu')
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce())
  expect(f.native).not.toHaveBeenCalled()
  release()
  await login
  expect(f.native).toHaveBeenCalledOnce()
})

it('stops a cancelled cold wake before probing or starting the tool', async () => {
  const f = fixture()
  const abort = new AbortController()
  let finish!: () => void
  f.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const run = f.host.integrations.cliToolPrepare('feishu', abort.signal)
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce())
  expect(f.prepare.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
  abort.abort()
  finish()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.ready).not.toHaveBeenCalled()
  expect(f.native).not.toHaveBeenCalled()
})

it('cancels login-start preparation through the host cancellation action', async () => {
  const f = fixture()
  f.ready.mockImplementationOnce(() => new Promise(() => {}))
  const run = f.host.integrations.cliLoginStart('feishu')
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce())
  await f.host.integrations.cancelAuthorization('feishu')
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.native).not.toHaveBeenCalled()
})

it('cancels an unanswered control read without waiting for the readiness timeout', async () => {
  const f = fixture()
  const abort = new AbortController()
  f.ready.mockImplementationOnce(() => new Promise(() => {}))
  const run = f.host.integrations.cliToolPrepare('feishu', abort.signal)
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce())
  abort.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.native).not.toHaveBeenCalled()
})

it('reads application and account metadata while the host is asleep without touching native APIs', async () => {
  const f = fixture()
  expect(await f.host.integrations.list('en-US')).toEqual([])
  expect(await f.host.integrations.checkAllConnections()).toEqual({})
  expect(await f.host.integrations.checkConfiguredConnections()).toEqual({})
  expect(await f.host.github.listAccounts()).toEqual([])
  expect(await f.host.integrations.cliLoginProgress('github')).toBeNull()
  const dispose = f.host.github.onEvent({ name: 'github-code' },() => {})
  expect(f.native).not.toHaveBeenCalled()
  expect(f.subscribe).not.toHaveBeenCalled()
  expect(f.prepare).not.toHaveBeenCalled()
  dispose()
})

it('prepares only an explicit authorization and installs its listeners before asking for a code', async () => {
  const f = fixture()
  const disposed = f.host.github.onEvent({ name: 'github-code' },() => {})
  await f.host.github.auth()
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.subscribe).toHaveBeenCalledOnce()
  expect(f.native).toHaveBeenCalledOnce()
  expect(f.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.subscribe.mock.invocationCallOrder[0])
  expect(f.subscribe.mock.invocationCallOrder[0]).toBeLessThan(f.native.mock.invocationCallOrder[0])
  disposed()
})

it('does not send an authorization after account ownership changes during preparation', async () => {
  const f = fixture()
  vi.mocked(f.panel.assertCurrent).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Account changed'))
  await expect(f.host.integrations.authorize('github')).rejects.toThrow('Account changed')
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.native).not.toHaveBeenCalled()
})

it('does not present an old credential check as an authorized account', async () => {
  const rows = [{ resource_key: 'catalog:github',data: { providerId: 'github' } },
    { resource_key: 'account',revision: '3',data: { providerId: 'github',configured: true,checkResult: 'ok',checkedAt: 10 } }]
  const panel = { collection: async () => rows, snapshot: async () => ({ application: [] }),
    body: async (row: typeof rows[number]) => new TextEncoder().encode(JSON.stringify(row.resource_key.startsWith('catalog:')
      ? { version: 1,en: { id: 'github',name: 'GitHub',auth: { methods: [] },capabilities: {} } } : { updatedAt: 20 })) } as unknown as AssistantPanelFiles
  expect((await readAssistantPanelIntegrations(panel,'en-US')).statuses.github?.connected).not.toBe(true)
})

// 2026-10-28 owner 在 Beta 上:助理住的云电脑停着,点「连接」报「此刻连不上」。第一问先叫醒(叫不醒照叫醒那一步的话明说),
// 叫醒之后每 20 秒一问不再重复叫醒。
it('wakes a sleeping home before the first install question and says so plainly when it cannot', async () => {
  const f = fixture()
  f.prepare.mockRejectedValueOnce(new Error('暂时无法使用授权所需的云端服务。'))
  await expect(f.host.integrations.cliToolPrepare('feishu')).rejects.toThrow('暂时无法使用授权所需的云端服务。')
  expect(f.native).not.toHaveBeenCalled()
  await f.host.integrations.cliToolPrepare('feishu')
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.prepare.mock.invocationCallOrder[1]).toBeLessThan(f.native.mock.invocationCallOrder[0])
  await f.host.integrations.cliToolPrepare('feishu')
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.native).toHaveBeenCalledTimes(2)
})

it('rechecks and wakes the home after a prepared control connection stops answering', async () => {
  const f = fixture()
  await f.host.integrations.cliToolPrepare('feishu')
  f.native.mockRejectedValueOnce(new Error('host fell asleep'))
  await expect(f.host.integrations.cliToolPrepare('feishu')).rejects.toThrow('host fell asleep')
  await f.host.integrations.cliToolPrepare('feishu')
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.ready).toHaveBeenCalledTimes(2)
  expect(f.prepare.mock.invocationCallOrder[1]).toBeLessThan(f.native.mock.invocationCallOrder[2])
})

it('resumes an active authorization rejected before attach and only retries its status read', async () => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  f.wait.mockRejectedValueOnce(Object.assign(new Error('The host is asleep'), { code: 'unreachable' }))
  await expect(f.host.integrations.cliLoginWait('feishu')).resolves.toEqual({ status: 'pending' })
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.wait).toHaveBeenCalledTimes(2)
  expect(f.prepare.mock.invocationCallOrder[1]).toBeLessThan(f.wait.mock.invocationCallOrder[1])
  expect(f.native).toHaveBeenCalledOnce() // Never repeat the non-idempotent login start.
})

it('continues the same authorization read through the transport handoff after resume', async () => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  f.wait.mockRejectedValueOnce(new Error('Host fell asleep')).mockRejectedValueOnce(new Error('Channel switching'))
  await expect(f.host.integrations.cliLoginWait('feishu')).resolves.toEqual({ status: 'pending' })
  expect(f.wait).toHaveBeenCalledTimes(3)
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.native).toHaveBeenCalledOnce()
})

it.each(['server_outdated', 'forbidden', 'unauthorized'])('keeps an authorization status refusal %s without a wake retry', async code => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  const refusal = Object.assign(new Error('Host rejected the request'), { code })
  f.wait.mockRejectedValueOnce(refusal)
  await expect(f.host.integrations.cliLoginWait('feishu')).rejects.toBe(refusal)
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.wait).toHaveBeenCalledOnce()
})

it('does not resume an authorization cancelled while its status read was pending', async () => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  let reject!: (error: Error) => void
  f.wait.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  const read = f.host.integrations.cliLoginWait('feishu')
  await vi.waitFor(() => expect(f.wait).toHaveBeenCalledOnce())
  await f.host.integrations.cancelAuthorization('feishu')
  reject(new Error('Host went offline'))
  await expect(read).rejects.toThrow()
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.wait).toHaveBeenCalledOnce()
})

it('reports the actual resume refusal instead of keeping an authorization waiting', async () => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  f.wait.mockRejectedValueOnce(new Error('Host went offline'))
  const refusal = new Error('Cloud resume was rejected')
  f.prepare.mockRejectedValueOnce(refusal)
  await expect(f.host.integrations.cliLoginWait('feishu')).rejects.toBe(refusal)
  expect(f.wait).toHaveBeenCalledOnce()
})

it('stops resume preparation when the active authorization is cancelled', async () => {
  const f = fixture()
  await f.host.integrations.cliLoginStart('feishu')
  f.wait.mockRejectedValueOnce(new Error('Host went offline'))
  f.ready.mockImplementationOnce(() => new Promise(() => {}))
  const read = f.host.integrations.cliLoginWait('feishu')
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(2))
  await f.host.integrations.cancelAuthorization('feishu')
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.wait).toHaveBeenCalledOnce()
})
