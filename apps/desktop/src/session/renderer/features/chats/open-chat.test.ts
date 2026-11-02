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
  expect(host.owned).toHaveBeenCalledWith('owned-dm');
  expect(host.show).not.toHaveBeenCalled();
});
it('mounts an owned DM file host without looking for an agent session', () => {
  host.owned.mockImplementation(() => { throw new Error('No session directory entry'); });
  openChatOnScreen('owned-dm', false, 'resource');
  expect(host.owned).not.toHaveBeenCalled();
  expect(host.show).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', chatId: 'owned-dm' });
});
it('keeps group files in their project block and preserves ordinary beside entry', () => {
  host.project.mockReturnValue('device-project'); host.row.mockReturnValue('sidebar-project');
  openChatOnScreen('group', false, 'resource');
  expect(host.show).toHaveBeenCalledWith({ kind: 'project', projectId: 'sidebar-project' });
  host.project.mockReturnValue(null);
  openChatOnScreen('human-dm', true);
  expect(host.beside).toHaveBeenCalledWith({ kind: 'chat', chatId: 'human-dm' });
});
