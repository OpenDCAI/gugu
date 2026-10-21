import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

// Keep both real layout layers: the production sidebar adds its own border beneath
// WorkspaceLayout. Replace only data/services and list contents unrelated to that edge.
vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/sessions/stores/session-agent-names', () => ({ sessionAgentNames: { start: () => {} } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { start: () => {} } }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => null }));
vi.mock('@renderer/features/assistant/assistant-home-sessions', () => ({ localHomeSessions: { sessions: [] } }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: () => {} }), useWorkspaceSlots: () => ({ currentView: 'home' }), isCurrentView: (current: string, view: string) => current === view }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { projects: { projects: new Map(), ensureMounted: vi.fn() } }, sidebarStore: { projectsCollapsed: true, setStateGroupsEnabled: () => {}, setAssistantAgentId: () => {}, setAssistantHomeProjectId: () => {}, setAgentNameOnHoverEnabled: () => {} } }));
vi.mock('@renderer/features/sidebar/session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, syncCursorFromPointer: () => {} } }));
vi.mock('@renderer/features/sidebar/use-sidebar-drop', () => ({ useSidebarDrop: () => ({ isDragOver: false }) }));
vi.mock('@renderer/features/sidebar/pinned-session-list', () => ({ SidebarPinnedSessionList: () => null }));
vi.mock('@renderer/features/sidebar/projects-group-label', () => ({ ProjectsGroupLabel: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-search-trigger', () => ({ SidebarSearchInput: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-space', () => ({ SidebarSpace: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-sessions-section', () => ({ SidebarSessionsSection: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-virtual-list', () => ({ SidebarVirtualList: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
  delete document.documentElement.dataset.windowMaterial;
  delete document.documentElement.dataset.theme;
});

it('the actual project sidebar has no full-height border behind the inset reading surface, while its resize target remains', async () => {
  await page.viewport(1000, 700);
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.windowMaterial = 'native';
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
    <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
      <WorkspaceLayout leftSidebar={<LeftSidebar />} mainContent={<div>reading surface</div>} />
    </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
  </div>);
  const sidebar = harness.container.querySelector<HTMLElement>('[data-region="left-sidebar"]')!;
  const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  expect(sidebar, 'the real inner sidebar must be present').not.toBeNull();
  expect(sidebar.getBoundingClientRect().height).toBe(700);
  expect(sidebar.getBoundingClientRect().width).toBe(240);
  expect(getComputedStyle(sidebar).borderInlineEndWidth).toBe('0px');
  expect(surface.getBoundingClientRect().top - sidebar.getBoundingClientRect().top).toBe(5);
  expect(sidebar.getBoundingClientRect().bottom - surface.getBoundingClientRect().bottom).toBe(5);
  const resize = harness.container.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  expect(resize.getAttribute('role')).toBe('separator');
  expect(resize.getBoundingClientRect().width).toBe(4);
  expect(resize.tabIndex).toBe(0);
});
