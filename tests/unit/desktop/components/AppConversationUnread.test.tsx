// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => ({ owner: 'owner-a', chats: [{ id: 'chat-a', unread_count: 2 }], inventory: [] as object[] }));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: state.owner ? { id: state.owner } : null }) }));
vi.mock('@/store/chatContext', () => ({ useChatStore: () => ({ chats: state.chats }) }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/session/renderer/lib/ipc', () => ({ rpc: { extensions: { conversationUnreadBindings: query } } }));
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  get manifests() { return state.inventory; }, manifestFor: () => ({ contributes: { unreadSource: { binding: 'main' } } }),
} }));
const { AppConversationUnread } = await import('../../../../apps/desktop/src/components/extensionBundle/AppConversationUnread');
let root: Root;
let element: HTMLDivElement;
const result = (ownerId = 'owner-a', chatId = 'chat-a') => ({ success: true, data: { ownerId, bindings: { reader: { ownerId, name: 'main', handle: `handle-${chatId}`, chatId } } } });
const render = async () => {
  await act(async () => root.render(<AppConversationUnread extensionId="reader">{unread => <span>{unread === null ? 'unknown' : unread ? 'unread' : 'read'}</span>}</AppConversationUnread>));
};
beforeEach(() => {
  state.owner = 'owner-a'; state.chats = [{ id: 'chat-a', unread_count: 2 }]; state.inventory = [{}];
  query.mockReset().mockResolvedValue(result());
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe('native App rail unread source lifetime and scope', () => {
  it('shows unread without creating an App page and follows native read updates without another authority read', async () => {
    await render(); expect(element.textContent).toBe('unread');
    state.chats = [{ id: 'chat-a', unread_count: 0 }]; await render();
    expect(element.textContent).toBe('read'); expect(query).toHaveBeenCalledTimes(1);
    state.chats = [{ id: 'chat-a', unread_count: 1 }]; await render();
    expect(element.textContent).toBe('unread');
  });
  it('does not reuse an in-flight grant across an inventory change or target replacement', async () => {
    let old!: (value: ReturnType<typeof result>) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
    await render(); expect(element.textContent).toBe('unknown');
    state.inventory = [{}]; state.chats = [{ id: 'chat-a', unread_count: 9 }, { id: 'chat-b', unread_count: 0 }];
    query.mockResolvedValue(result('owner-a', 'chat-b')); await render();
    expect(element.textContent).toBe('read');
    await act(async () => old(result()));
    expect(element.textContent).toBe('read'); expect(query).toHaveBeenCalledTimes(2);
  });
  it('hides the old account immediately and ignores its late response after switching accounts', async () => {
    let old!: (value: ReturnType<typeof result>) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { old = resolve; })); await render();
    state.owner = 'owner-b'; state.chats = [{ id: 'chat-b', unread_count: 0 }];
    query.mockResolvedValue(result('owner-b', 'chat-b')); await render(); expect(element.textContent).toBe('read');
    await act(async () => old(result())); expect(element.textContent).toBe('read');
    state.owner = ''; await render(); expect(element.textContent).toBe('unknown');
  });
  it('reports unknown on failed verification or unavailable source, and removes a confirmed withdrawn grant', async () => {
    query.mockResolvedValue({ success: false, error: 'unavailable' }); await render(); expect(element.textContent).toBe('unknown');
    state.inventory = [{}]; query.mockResolvedValue(result()); state.chats = []; await render(); expect(element.textContent).toBe('unknown');
    state.inventory = [{}]; state.chats = [{ id: 'chat-a', unread_count: 3 }]; query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: {} } });
    await render(); expect(element.textContent).toBe('unknown');
  });
});
