import { beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  owned: vi.fn(), show: vi.fn(), beside: vi.fn(), project: vi.fn(), row: vi.fn(), screen: vi.fn(),
}));
vi.mock('@/lib/ownedAgentConversation', () => ({ openOwnedAgentEntry: host.owned }));
vi.mock('@renderer/app/screen-layout-actions', () => ({
  isScreenView: host.screen, showOnScreen: host.show, showBesideOnScreen: host.beside,
}));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: { projectOfChat: host.project } }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'screen' } }, sidebarStore: { rowProjectIdOf: host.row },
}));
import { openChatOnScreen } from './open-chat';
beforeEach(() => {
  vi.resetAllMocks(); host.screen.mockReturnValue(true); host.row.mockImplementation(id => id);
});
it('keeps ordinary owned-agent navigation on its existing task', () => {
  host.owned.mockReturnValue(true);
  openChatOnScreen('owned-dm', false);
  expect(host.owned).toHaveBeenCalledWith('owned-dm', undefined, undefined, undefined, undefined);
  expect(host.show).not.toHaveBeenCalled();
});
it('opens owned DM resources in the existing native session without an IM block', () => {
  host.owned.mockReturnValue(true);
  openChatOnScreen('owned-dm', false, 'resource');
  expect(host.owned).toHaveBeenCalledExactlyOnceWith('owned-dm', undefined, undefined, undefined, 'resource');
  expect(host.show).not.toHaveBeenCalled();
  expect(host.beside).not.toHaveBeenCalled();
});
it('keeps group files in their project block and preserves ordinary beside entry', () => {
  host.project.mockReturnValue('device-project'); host.row.mockReturnValue('sidebar-project');
  openChatOnScreen('group', false, 'resource');
  expect(host.show).toHaveBeenCalledWith({ kind: 'project', projectId: 'sidebar-project' });
  host.project.mockReturnValue(null);
  openChatOnScreen('human-dm', true);
  expect(host.beside).toHaveBeenCalledWith({ kind: 'chat', chatId: 'human-dm' });
});
