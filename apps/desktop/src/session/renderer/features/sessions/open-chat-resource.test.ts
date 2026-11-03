import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ prepare: vi.fn(), session: vi.fn(), open: vi.fn() }));
vi.mock('./session-pane-ready', () => ({ prepareSessionPane: state.prepare }));
vi.mock('./stores/session-selectors', () => ({ getSessionPageStore: state.session, asProvisioned: (value: unknown) => value }));
vi.mock('@/lib/ownedAgentResources', () => ({ ownedAgentResourceTabs: () => ({ read: () => ({ item: { kind: 'workspace.main', itemId: 'file', title: 'receipt.html' } }) }) }));
import { openChatResource } from './open-chat-resource';
const target = { projectId: 'project', sessionId: 'native-session', chatId: 'owned-dm', sourceTabId: 'authorized-file' };
beforeEach(() => { vi.resetAllMocks(); });
it('opens the authorized resource beside the native session without a chat route', async () => {
  state.session.mockReturnValue({ viewModel: { paneLayout: { open: state.open } } });
  await openChatResource(target);
  expect(state.prepare).toHaveBeenCalledWith('project', 'native-session', { reviveArchived: false });
  expect(state.open).toHaveBeenCalledExactlyOnceWith('chat-resource', { chatId: 'owned-dm', sourceTabId: 'authorized-file', item: { kind: 'workspace.main', itemId: 'file', title: 'receipt.html' } }, { from: null, intent: 'beside' });
});
it('reports an unavailable native session instead of falling back to an IM transcript', async () => {
  state.session.mockReturnValue(null);
  await expect(openChatResource(target)).rejects.toThrow('agent session is unavailable');
  expect(state.open).not.toHaveBeenCalled();
});
