import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ summary: vi.fn(), owns: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/ownedAgentConversation', () => ({ isOwnedAgentPeer: state.owns, openOwnedAgentEntry: state.open }));
vi.mock('@/lib/chatSummariesBridge', () => ({ readChatSummary: state.summary }));
vi.mock('@renderer/lib/modal/modal-store', () => ({ modalStore: { closeModal: vi.fn() } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { push: vi.fn() }, sidebar: { revealActiveSession: vi.fn() } } }));
import { chatView } from './view';
import { NavigationStore } from '@renderer/lib/stores/navigation-store';
beforeEach(() => { vi.resetAllMocks(); });
it('rejects owned-agent IM routes for direct navigation, history and old snapshots', () => {
  state.summary.mockReturnValue({ kind: 'dm', peerUserId: 'owned-agent' });
  state.owns.mockReturnValue(true);
  const navigation = new NavigationStore();
  for (const view of ['home', 'screen', 'chat'] as const) navigation.registerView(view);
  navigation.registerGuard('chat', chatView.canActivate);
  navigation.navigate('chat', { chatId: 'owned-dm' });
  expect(navigation.currentViewId).toBe('screen');
  navigation._applyNavigation('chat', { chatId: 'owned-dm' });
  expect(navigation.currentViewId).toBe('screen');
  navigation.restoreSnapshot({ currentViewId: 'chat', viewParams: { chat: { chatId: 'owned-dm' } } });
  expect(navigation.currentViewId).toBe('screen');
  expect(state.open).toHaveBeenCalledTimes(3);
  expect(state.open).toHaveBeenCalledWith('owned-dm');
});
it.each(['dm', 'group', 'topic'])('preserves the shared %s host for other conversations', kind => {
  state.summary.mockReturnValue({ kind, peerUserId: 'someone-else' });
  expect(chatView.canActivate({ chatId: 'conversation' })).toEqual({ ok: true });
  expect(state.open).not.toHaveBeenCalled();
});
