import { readAssistantPanelIntegrations } from '../../apps/desktop/src/components/assistant/assistant-panel-integrations'
import { expect, it, vi } from 'vitest'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { LibraryHost } from '../../apps/desktop/src/session/renderer/features/library/library-host'
import { assistantPanelLibraryHost } from '../../apps/desktop/src/components/assistant/assistant-panel-library-host'

function fixture() {
  const native = vi.fn(async () => ({ success: true })), subscribe = vi.fn(() => vi.fn()), ready = vi.fn(async () => ({}))
  const base = { key: 'native',remote: { online: false },
    integrations: { connect: native,authorize: native,cliLoginStart: native,cliToolPrepare: native,cliLoginProgress: native,cancelAuthorization: native,
      list: native,accounts: native,checkAllConnections: native,checkConfiguredConnections: ready },
    github: { auth: native,authCancel: native,listAccounts: native,importCliAccounts: native,onEvent: subscribe },
  } as unknown as LibraryHost
  const panel = { ownerId: 'owner',assistantId: 'assistant',assertCurrent: vi.fn(async () => {}),
    collection: vi.fn(async () => []),snapshot: vi.fn(async () => ({ application: [] })),body: vi.fn(),change: vi.fn(),save: vi.fn(),
  } as unknown as AssistantPanelFiles
  const prepare = vi.fn(async () => {})
  return { native,subscribe,panel,prepare,ready,host: assistantPanelLibraryHost(base,panel,prepare) }
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
