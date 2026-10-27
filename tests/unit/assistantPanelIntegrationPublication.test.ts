import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ meta: undefined as Record<string, string> | undefined, verified: null as { checkedAt: number; checks: { accountId: string; connected: boolean; errorType?: string }[] } | null }))
vi.mock('@main/db/client',() => ({ db: {} }))
vi.mock('@main/core/sessions/getSessions',() => ({ getSessions: vi.fn() }))
vi.mock('@main/core/session-timeline/service',() => ({ listSessionStates: vi.fn() }))
vi.mock('@main/core/automations/repo',() => ({ listSessionSchedules: vi.fn() }))
vi.mock('@main/core/automations/automations-service',() => ({ automationsService: {} }))
vi.mock('@main/core/provider-accounts/provider-account-registry-instance',() => ({ providerAccountRegistry: { listAccounts: async () => [{ accountId: 'one',createdAt: 10,updatedAt: 30,isDefault: true,meta: fixture.meta }] } }))
vi.mock('@gugu/session-plugins/integrations',() => ({ integrationPluginRegistry: { getAll: () => [{ metadata: { id: 'mail' } }] } }))
vi.mock('@main/core/integrations/integration-payload-builder',() => ({ buildIntegrationListPayload: vi.fn() }))
vi.mock('@gugu/core',() => ({ listAgents: vi.fn() }))
vi.mock('../../apps/desktop/electron/session/main/core/app/user-library',() => ({ onUserLibraryChanged: vi.fn(),readUserLibraryVolume: vi.fn(),readUserLibraryEntry: vi.fn(),writeUserLibraryEntry: vi.fn(),removeUserLibraryEntry: vi.fn() }))
vi.mock('../../apps/desktop/electron/session/main/core/app/assistant-panel-integration-checks',() => ({ panelIntegrationChecks: () => fixture.verified,integrationAccountSignature: vi.fn(() => 'generation') }))
import { assistantPanelLocal } from '../../apps/desktop/electron/session/main/core/app/assistant-panel-local'
beforeEach(() => { fixture.verified = null; fixture.meta = undefined })

it('omits both old check fields while the new credentials have not been verified',async () => {
  const [row] = await assistantPanelLocal.integrations('owner')
  expect(row).toMatchObject({ providerId: 'mail',accountId: 'one',configured: true })
  expect(row).not.toHaveProperty('checkResult')
  expect(row).not.toHaveProperty('checkedAt')
  expect(row?.displayName).toBeUndefined()
})
it('does not publish a stale or missing account check as a current failure',async () => {
  fixture.verified = { checkedAt: 20,checks: [{ accountId: 'one',connected: true }] }
  expect((await assistantPanelLocal.integrations('owner'))[0]).not.toHaveProperty('checkResult')
  fixture.verified = { checkedAt: 40,checks: [] }
  expect((await assistantPanelLocal.integrations('owner'))[0]).not.toHaveProperty('checkedAt')
})
it('publishes only an actual current verification, including expired authorization',async () => {
  fixture.verified = { checkedAt: 40,checks: [{ accountId: 'one',connected: false,errorType: 'authorization_expired' }] }
  expect((await assistantPanelLocal.integrations('owner'))[0]).toMatchObject({ checkResult: 'reauth',checkedAt: 40 })
})

it('publishes a real display name or login without falling back to the credential key', async () => {
  fixture.meta = { login: 'ada@example.com' }
  expect((await assistantPanelLocal.integrations('owner'))[0]?.displayName).toBe('ada@example.com')
  fixture.meta = { displayName: '研究团队', login: 'ada@example.com' }
  expect((await assistantPanelLocal.integrations('owner'))[0]?.displayName).toBe('研究团队')
})
