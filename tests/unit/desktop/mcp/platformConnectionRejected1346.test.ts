import { describe, expect, it, vi } from 'vitest'
import { createPlatformIntegrationsClient } from '@gugu/core/cloud/platformIntegrations'
import type { PlatformCredentialDeps } from '../../../../apps/desktop/electron/session/main/core/integrations/platform-credentials'

vi.mock('@gugu/session-plugins/integrations', () => ({ integrationPluginRegistry: { getAll: () => [] } }))
import { PlatformCredentialService } from '../../../../apps/desktop/electron/session/main/core/integrations/platform-credentials'

function fixture() {
  let version = '2026-11-02T12:00:00.000001Z'
  let connected = true
  let release: (() => void) | null = null
  let hold: Promise<void> | null = null
  const read = vi.fn(async () => {
    const response = Response.json({ providers: [{ provider: 'baidu-pan', accounts: [{
      accountId: 'default', connected, state: connected ? 'connected' : 'reconnect',
      updatedAt: version, checkedAt: version, disconnectedAt: null,
    }] }] })
    if (hold) await hold
    return response
  })
  const client = createPlatformIntegrationsClient({
    baseUrl: 'https://platform.test', accessToken: async () => 'fixture-user-jwt',
    fetch: (async (input) => String(input).endsWith('/integrations') ? read() : Response.json({ error: 'credential_rejected' }, { status: 409 })) as typeof fetch,
  })
  const accounts = {
    listAccounts: vi.fn(async () => []), upsertAccount: vi.fn(async () => ({})),
    removeAccount: vi.fn(), removeAllAccounts: vi.fn(), clearSecret: vi.fn(), resolveSecret: vi.fn(),
  } as unknown as PlatformCredentialDeps['accounts']
  const service = new PlatformCredentialService({ client: () => client, accounts, providers: () => [{ id: 'baidu-pan', name: '百度网盘', fields: [], oauth: true }], log: { info: vi.fn(), warn: vi.fn() } })
  return { service, read,
    nextGrant: () => { version = '2026-11-02T12:01:00.000001Z'; connected = true },
    rejected: () => { connected = false },
    hold: () => { hold = new Promise<void>((resolve) => { release = resolve }) },
    release: () => { hold = null; release?.() },
  }
}

describe('platform OAuth rejection state (#1346 review)', () => {
  it('refreshes after rejection but cannot replace it with a stale connected answer about the same grant', async () => {
    const f = fixture()
    await f.service.refresh()
    expect(await f.service.isConnected('baidu-pan')).toBe(true)
    const endpoint = await f.service.mcpEndpoint('baidu-pan')
    await expect(endpoint.fetch(endpoint.url, { method: 'POST' })).rejects.toThrow()
    await f.service.refresh({ maxAgeMs: 0 })
    expect(f.read.mock.calls.length).toBeGreaterThan(1)
    expect(await f.service.isConnected('baidu-pan')).toBe(false)
    expect(await f.service.check('baidu-pan')).toMatchObject({ connected: false, errorType: 'authorization_expired' })
    f.nextGrant()
    await f.service.refresh({ maxAgeMs: 0 })
    expect(await f.service.isConnected('baidu-pan')).toBe(true)
  })
  it('ignores a late rejection from an older grant after another device reconnects', async () => {
    const f = fixture()
    await f.service.refresh()
    const old = await f.service.mcpEndpoint('baidu-pan')
    f.nextGrant()
    await f.service.refresh({ maxAgeMs: 0 })
    await expect(old.fetch(old.url, { method: 'POST' })).rejects.toThrow()
    expect(await f.service.isConnected('baidu-pan')).toBe(true)
  })
  it('discards a connected list already in flight when a rejection arrives', async () => {
    const f = fixture()
    await f.service.refresh()
    const endpoint = await f.service.mcpEndpoint('baidu-pan')
    f.hold()
    const stale = f.service.refresh({ maxAgeMs: 0 })
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
    f.rejected()
    await expect(endpoint.fetch(endpoint.url, { method: 'POST' })).rejects.toThrow()
    f.release()
    expect(await stale).toBe(false)
    await f.service.refresh({ maxAgeMs: 0 })
    expect(await f.service.isConnected('baidu-pan')).toBe(false)
  })
})
