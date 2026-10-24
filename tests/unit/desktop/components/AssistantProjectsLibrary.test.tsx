// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantProjectsLibrary } from '../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const mocks = vi.hoisted(() => ({ listProjectFolders: vi.fn(async () => ({ success: true, data: [] })) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({
  devices: [{ device_id: 'remote-cloud', label: '助理所在设备', is_online: true }], loading: false, error: null,
}) }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({
  useLiveDeviceSessions: () => new Map(),
  deviceSessionsOf: () => ({ loading: false, error: null, projects: [
    { id: 'gugu-existing-id', name: '长期发布', path: '/home/咕咕项目/长期发布' },
    { id: 'assistant-home', name: '助理', path: '/home/助理' },
  ] }),
}))
vi.mock('../../../../apps/desktop/src/store/auth', async importOriginal => ({ ...await importOriginal<object>(), useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: (device: string) => { expect(device).toBe('remote-cloud'); return { projects: mocks } },
}))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks() })
afterEach(() => harness.cleanup())
it('reads the cross-device directory on desktop and opens the existing project on its owning device', async () => {
  const machine = { deviceId: 'remote-cloud', projectId: 'assistant-home' } as Parameters<typeof AssistantProjectsLibrary>[0]['machine']
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={machine} />)
  expect(harness.container.textContent).toContain('长期发布')
  expect(harness.container.querySelector('[data-testid="assistant-project-assistant-home"]')).toBeNull()
  await clickElement(harness.container.querySelector('[data-testid="assistant-project-gugu-existing-id"]')!)
  await vi.waitFor(() => expect(mocks.listProjectFolders).toHaveBeenCalledWith('gugu-existing-id'))
})
