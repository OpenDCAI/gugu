// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { AssistantProjectsLibrary, AssistantProjectsCard } from '../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
const state = vi.hoisted(() => ({ read: vi.fn(),refresh: vi.fn(),native: vi.fn(() => { throw new Error('Unexpected device directory read') }) }))
vi.mock('@/platform',() => ({ platform: { capabilities: { agentRuntime: false } } }))
vi.mock('@/session/renderer/lib/stores/app-state',() => ({ appState: {} }))
vi.mock('@/hooks/useSessionpageReveal',() => ({ revealSessionpage: vi.fn() }))
vi.mock('@/lib/deviceProjects',() => ({ listMyDeviceProjects: state.read }))
vi.mock('@/store/devicesContext',() => ({ useDevicesStore: () => ({ devices: [{ device_id: 'mac',label: 'apple 的 MacBook',is_online: false },{ device_id: 'fc',label: 'FC验收Mac',is_online: false }],loading: false,error: null,refresh: state.refresh }) }))
vi.mock('@/session/shared/remote-sessions/session-directory',() => ({ useLiveDeviceSessions: state.native,deviceSessionsOf: state.native }))
let harness: ReturnType<typeof createReactHarness>
const project = (id: string,name: string) => ({ localProjectId: id,name,rootPath: '/fixture',createdAt: '2026-10-26',chatId: null,groupRepresentative: false,folders: [] })
beforeEach(() => { harness = createReactHarness(); state.native.mockClear(); state.read.mockReset().mockResolvedValue({ mac: [project('00000000-0000-4000-8000-000000000001','~'),project('gugu','咕咕')],fc: [project('00000000-0000-4000-8000-000000000001','~')] }) })
afterEach(() => harness.cleanup())
it('lists every account project while both devices are asleep and opens an empty project entry', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('FC验收Mac'))
  const rows = [...harness.container.querySelectorAll<HTMLElement>('[data-testid^="assistant-project-"]')]
  expect(rows).toHaveLength(3)
  expect(harness.container.textContent).toContain('apple 的 MacBook')
  expect(harness.container.textContent).toContain('咕咕')
  expect(harness.container.textContent).not.toContain('与咕咕项目页使用同一份项目')
  await clickElement(rows[0]!)
  expect(harness.container.querySelector('[data-testid="assistant-project-cloud-index"]')).not.toBeNull()
  expect(state.native).not.toHaveBeenCalled()
})
it('counts the same three entries on the memory page', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsCard machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('3 条记录'))
  expect(state.native).not.toHaveBeenCalled()
})
it('explains a cloud directory failure without inventing an empty list or exposing a retry button', async () => {
  state.read.mockRejectedValue(new Error('private SQL diagnostic'))
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
  expect(harness.container.textContent).not.toContain('private SQL diagnostic')
  expect(harness.container.textContent).not.toContain('还没有咕咕项目')
  expect([...harness.container.querySelectorAll('button')].some(button => button.textContent === '重试')).toBe(false)
})
