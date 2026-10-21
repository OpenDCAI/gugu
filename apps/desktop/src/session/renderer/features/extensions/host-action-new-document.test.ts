// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { extensionSurfaceStore } from './extension-surface-store';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';

vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));

const { applyExtensionHostAction } = await import('./host-action-handlers');

/**
 * 10-19 on mac1: 论文共读's reader named the group panel after its paper (`setTabTitle`); its back button is
 * `location.href = 'shelf.html'`, another document in the same page, and the shelf says no title — the panel kept the
 * paper's title over the shelf, after the paper was deleted too. What a page says about itself lasts as long as the
 * document that said it: main tells the window `newDocument` (extension-bridge.ts `sayAboutPage`), and the slot is back
 * on the manifest's title. Control (the parent commit): no such action — the paper's title stayed.
 */
describe('a page that loads another document starts from the manifest title again', () => {
  const el = () => document.createElement('div');
  const origin = { extensionId: 'paper-club', sessionId: null, tabId: 'panel' };

  it('reader → shelf: the paper’s title, badge and error go; the slot reads null and draws the manifest’s title', () => {
    const chatId = 'chat-new-document';
    extensionViewStore.claim('paper-club.shelf', { tabId: 'panel', chatId, element: el() });
    applyExtensionHostAction({ origin, action: { kind: 'setTabTitle', title: 'Attention Is All You Need' } });
    applyExtensionHostAction({ origin, action: { kind: 'setTabBadge', badge: 2 } });
    applyExtensionHostAction({ origin, action: { kind: 'reportError', message: 'This file was deleted' } });
    expect(extensionSurfaceStore.said(null, 'panel')).toEqual({ title: 'Attention Is All You Need', badge: 2, error: 'This file was deleted' });

    applyExtensionHostAction({ origin, action: { kind: 'newDocument' } });
    expect(extensionSurfaceStore.said(null, 'panel')).toEqual({ title: null, badge: null, error: null });
    expect(extensionSurfaceStore.sharedState(residentPageKey('paper-club.shelf', residentPlace({ chatId })))).toEqual({ title: null, badge: null, error: null });

    // The new document names itself again as it likes: that sticks until its own next document.
    applyExtensionHostAction({ origin, action: { kind: 'setTabTitle', title: 'Chain-of-Thought Prompting' } });
    expect(extensionSurfaceStore.said(null, 'panel').title).toBe('Chain-of-Thought Prompting');
  });
});
