import { expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({
  automations: [{ id: 'morning',agentSessionId: 'assistant' },{ id: 'evening',agentSessionId: 'assistant' },{ id: 'reminder',agentSessionId: 'assistant' },{ id: 'other',agentSessionId: 'other' }],
  schedules: [{ id: 'morning',nextRunAt: 20,lastRun: { status: 'done',at: 10,error: null } },{ id: 'evening',nextRunAt: 30,lastRun: { status: 'failed',at: 11,error: { code: 'deadline_exceeded',details: 'private provider response' } } }],
}))
vi.mock('@main/db/client',() => ({ db: {} }))
vi.mock('@main/core/sessions/getSessions',() => ({ getSessions: vi.fn() }))
vi.mock('@main/core/session-timeline/service',() => ({ listSessionStates: vi.fn() }))
vi.mock('@main/core/automations/repo',() => ({ listSessionSchedules: () => data.schedules }))
vi.mock('@main/core/automations/automations-service',() => ({ automationsService: { listAutomations: async () => data.automations } }))
vi.mock('@main/core/provider-accounts/provider-account-registry-instance',() => ({ providerAccountRegistry: {} }))
vi.mock('@gugu/session-plugins/integrations',() => ({ integrationPluginRegistry: {} }))
vi.mock('@main/core/integrations/integration-payload-builder',() => ({ buildIntegrationListPayload: vi.fn() }))
vi.mock('@gugu/core',() => ({ listAgents: vi.fn() }))
vi.mock('../../apps/desktop/electron/session/main/core/app/user-library',() => ({ onUserLibraryChanged: vi.fn(),readUserLibraryVolume: vi.fn(),readUserLibraryEntry: vi.fn(),writeUserLibraryEntry: vi.fn(),removeUserLibraryEntry: vi.fn() }))
vi.mock('../../apps/desktop/electron/session/main/core/app/assistant-panel-integration-checks',() => ({ panelIntegrationChecks: vi.fn() }))
import { assistantPanelLocal } from '../../apps/desktop/electron/session/main/core/app/assistant-panel-local'
it('publishes all owned schedules with only public run status, time and error code',async () => {
  const rows = await assistantPanelLocal.schedules(['assistant'])
  expect(rows.map(row => row.id)).toEqual(['morning','evening','reminder'])
  expect(rows[0]!.lastRun).toEqual({ status: 'done',at: 10,errorCode: null })
  expect(rows[1]!.lastRun).toEqual({ status: 'failed',at: 11,errorCode: 'deadline_exceeded' })
  expect(rows[2]!.lastRun).toBeNull()
  expect(JSON.stringify(rows)).not.toContain('private provider response')
})
