// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { APP_COMPOSE_EVENT, type AppComposeDetail } from '@shared/extensions/app-runtime-protocol';

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

const { applyExtensionHostAction } = await import('./host-action-handlers');

/**
 * App 引用 pill: the pills `gugu.compose`'s refs made reach the chat shell beside the text, as the phone's page hands
 * them — words and links, for the composer to hold. Control: a compose without refs carries none.
 */
describe("a chat's compose hands the chat shell its pills", () => {
  it('refs go with the text; none named, none carried', () => {
    const composed: AppComposeDetail[] = [];
    const take = (event: Event) => composed.push((event as CustomEvent<AppComposeDetail>).detail);
    window.addEventListener(APP_COMPOSE_EVENT, take);
    const refs = [{ label: '演示稿 · 第 3 页 · 标题', link: 'gugu-file://0c000000-0000-4000-8000-000000000016?v=7#slide=3&shape=12' }];
    try {
      applyExtensionHostAction({ origin: { sessionId: null, tabId: 'slot-1' }, action: { kind: 'compose', detail: { chatId: 'chat-1', text: '', refs } } } as never);
      applyExtensionHostAction({ origin: { sessionId: null, tabId: 'slot-1' }, action: { kind: 'compose', detail: { chatId: 'chat-1', text: 'x\n' } } } as never);
    } finally {
      window.removeEventListener(APP_COMPOSE_EVENT, take);
    }
    expect(composed).toEqual([{ chatId: 'chat-1', text: '', refs }, { chatId: 'chat-1', text: 'x\n' }]);
  });
});
