// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { UI_EVENTS } from '@/lib/uiEvents';

const navigate = vi.fn();
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));
vi.mock('./extension-surface-store', () => ({
  extensionSurfaceStore: { say: vi.fn() },
}));

const { applyExtensionHostAction } = await import('./host-action-handlers');

/**
 * R A/B 10-06: a banner's or a link's click that names no place opens the App's own page, which lives on the task
 * surface — from the chats page it opened unseen, the shell stayed on chats. Control (0a436892f1): no reveal asked.
 */
describe("a click that opens the App's own page brings the task page forward", () => {
  it('navigates to the App and asks the shell to show the task page', () => {
    const revealed = vi.fn();
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed);
    try {
      applyExtensionHostAction({ origin: null, action: { kind: 'openApp', extensionId: 'board' } } as never);
      expect(navigate).toHaveBeenCalledWith('app', { appId: 'board' });
      expect(revealed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(UI_EVENTS.sessionpageReveal, revealed);
    }
  });
});
