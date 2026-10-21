// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_LISTED_SESSION_METHOD } from '@shared/extensions/host-actions';

vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));
vi.mock('./extension-surface-store', () => ({
  extensionSurfaceStore: { say: vi.fn() },
}));
// The task list's own reading (remote-hosts-store.test.ts has how it places a row): another computer's s-far, under p-far.
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { listedProject: (sessionId: string) => (sessionId === 's-far' ? 'p-far' : null) },
}));

const { extensionHostActionHandlers } = await import('./host-action-handlers');
const ask = (params: unknown) => extensionHostActionHandlers[EXTENSION_LISTED_SESSION_METHOD]!(params);

/**
 * #7158 `gugu.showSession` asks the window over the App command channel which project its task list has a session under.
 * The window only answers: main brings the session up the one way a banner's click does.
 */
describe('the window says which project its task list has a session under', () => {
  it('a listed session: its project; one the list does not have: null', async () => {
    await expect(ask({ sessionId: 's-far' })).resolves.toBe('p-far');
    await expect(ask({ sessionId: 's-nowhere' })).resolves.toBeNull();
  });

  it('a request without a session id is refused, never answered null', async () => {
    for (const params of [null, {}, { sessionId: 42 }]) await expect(ask(params)).rejects.toThrow('Invalid listed session request');
  });
});
