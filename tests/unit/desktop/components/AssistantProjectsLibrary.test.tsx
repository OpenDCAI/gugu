// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantProjectsLibrary, AssistantProjectsCard } from '../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const store = vi.hoisted(() => ({ sidebar: {
  orderedProjects: [{ id: 'gugu-existing-id', name: '天安门旅游', data: { path: '/projects/travel' } }],
  homeLayout: { homeRows: new Set<string>(), standIns: new Map<string, string>() }, machines: { machineOf: (id: string) => id === 'home-remote' ? 'remote-device' : id === 'home-assistant' ? 'assistant-device' : null, label: (id: string) => id === 'assistant-device' ? '咕咕' : 'FC验收Mac' }, projectLabel: () => '天安门旅游', ensureProjectExpanded: vi.fn(),
}, navigation: { navigate: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: store }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'local-device', label: 'apple 的 MacBook', is_current_device: true }, { device_id: 'remote-device', label: 'FC验收Mac' }, { device_id: 'assistant-device', label: '助理' }] }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { agentRuntime: true } } }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks(); store.sidebar.orderedProjects = [{ id: 'gugu-existing-id', name: '天安门旅游', data: { path: '/projects/travel' } }]; store.sidebar.homeLayout.homeRows.clear() })
afterEach(() => harness.cleanup())
it('uses the existing Gugu project ID and opens that same project, without scanning or creating folders', async () => {
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  expect(harness.container.textContent).toContain('天安门旅游')
  await clickElement(harness.container.querySelector('[data-testid="assistant-project-gugu-existing-id"]')!)
  expect(store.navigation.navigate).toHaveBeenCalledWith('project', { projectId: 'gugu-existing-id' })
  expect(store.sidebar.ensureProjectExpanded).toHaveBeenCalledWith('gugu-existing-id')
})

it('retains every sidebar home row, uses device names and counts the same three entries', async () => {
  store.sidebar.orderedProjects = [
    { id: 'home-local', name: '~', data: { path: '/Users/apple' } },
    { id: 'home-assistant', name: 'wuying', data: { path: '/home/wuying' } },
    { id: 'home-remote', name: 'apple', data: { path: '/Users/apple' } },
  ]
  for (const project of store.sidebar.orderedProjects) store.sidebar.homeLayout.homeRows.add(project.id)
  await renderWithAppProviders(harness, <AssistantProjectsCard machine={null} />)
  expect(harness.container.textContent).toContain('3')
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  for (const name of ['apple 的 MacBook', '咕咕', 'FC验收Mac']) expect(harness.container.textContent).toContain(name)
  expect(harness.container.textContent).not.toContain('与咕咕项目页使用同一份项目')
  expect(harness.container.textContent).not.toContain('~')
  for (const project of store.sidebar.orderedProjects) {
    await clickElement(harness.container.querySelector(`[data-testid="assistant-project-${project.id}"]`)!)
    expect(store.navigation.navigate).toHaveBeenLastCalledWith('project', { projectId: project.id })
    expect(store.sidebar.ensureProjectExpanded).toHaveBeenLastCalledWith(project.id)
  }
})
