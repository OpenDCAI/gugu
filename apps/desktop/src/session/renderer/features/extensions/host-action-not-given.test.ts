// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const { toast, followLink } = vi.hoisted(() => ({ toast: vi.fn(), followLink: vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@/lib/guguLinks', () => ({ followLink, openLinkTarget: vi.fn() }));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ panelTabsOf: () => [], showChatTab: vi.fn(), updateFileNames: vi.fn() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: new Map() }) }));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }));
vi.mock('./extension-surface-store', () => ({ extensionSurfaceStore: { say: vi.fn() } }));

const { applyExtensionHostAction } = await import('./host-action-handlers');

/**
 * #607 follow-up: an install asked for a chat whose row could not be written used only to log it. Now the window says
 * 「没加上群 X」 and its button opens the App's page in 「App」, where a chat is added.
 */
it('an install that could not give its chat: a toast naming the chat, whose button opens the App page', () => {
  applyExtensionHostAction({ origin: null, action: { kind: 'notGivenAt', extensionId: 'searcher', chat: { id: 'h', name: 'Team H' } } });
  expect(toast).toHaveBeenCalledTimes(1);
  const shown = toast.mock.calls[0]![0] as { title: string; action: { label: string; onClick: () => void } };
  expect(shown.title).toContain('Team H');
  shown.action.onClick();
  expect(followLink).toHaveBeenCalledWith({ kind: 'app-detail', extensionId: 'searcher' });
});
