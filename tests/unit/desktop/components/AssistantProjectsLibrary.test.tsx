// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantProjectsLibrary } from '../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const store = vi.hoisted(() => ({ sidebar: {
  orderedProjects: [{ id: 'gugu-existing-id', name: '天安门旅游', data: { path: '/projects/travel' } }],
  homeLayout: { homeRows: new Map() }, projectLabel: () => '天安门旅游', ensureProjectExpanded: vi.fn(),
}, navigation: { navigate: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: store }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { agentRuntime: true } } }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks() })
afterEach(() => harness.cleanup())
it('uses the existing Gugu project ID and opens that same project, without scanning or creating folders', async () => {
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  expect(harness.container.textContent).toContain('天安门旅游')
  await clickElement(harness.container.querySelector('[data-testid="assistant-project-gugu-existing-id"]')!)
  expect(store.navigation.navigate).toHaveBeenCalledWith('project', { projectId: 'gugu-existing-id' })
  expect(store.sidebar.ensureProjectExpanded).toHaveBeenCalledWith('gugu-existing-id')
})
