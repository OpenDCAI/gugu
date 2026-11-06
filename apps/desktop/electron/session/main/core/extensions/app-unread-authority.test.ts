import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: '11000000-0000-4000-8000-000000000001', authority: '', allowed: true, handle: 'opaque', member: true, afterMember: undefined as (() => void) | undefined, afterChoices: undefined as (() => void) | undefined }));
const CHAT = '33000000-0000-4000-8000-000000000003';
const AUTHORITY = '44000000-0000-4000-8000-000000000004';
const get = vi.hoisted(() => vi.fn());
const set = vi.hoisted(() => vi.fn());
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => { state.afterChoices?.(); return []; } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({ conversationUnreadBinding: get, setConversationUnreadBinding: set,
  conversationUnreadAuthority: (owner: string, app: string, name: string) => { get(owner, app, name); return state.authority; },
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => {
    state.afterMember?.(); return { data: state.member ? { chat_id: CHAT } : null, error: null };
  } }; return query;
} }) }));
const { appUnreadBinding, setUnreadBinding, unreadBindingChoices } = await import('./app-unread-bindings');

beforeEach(() => {
  state.owner = '11000000-0000-4000-8000-000000000001'; state.allowed = true; state.member = true; state.handle = 'opaque'; state.afterMember = undefined;
  state.authority = AUTHORITY; state.afterChoices = undefined;
  get.mockReset().mockImplementation((_owner, _app, name) => {
    if (!state.allowed || name !== 'main') throw Object.assign(new Error('Denied'), { code: 'denied' });
    return { ownerId: state.owner, name: 'main', chatId: CHAT, handle: state.handle };
  }); set.mockReset();
});
describe('host authorization around asynchronous membership reads', () => {
  it('returns only an opaque reference, never target identity or message data', async () => {
    expect(await appUnreadBinding('reader', { name: 'main' })).toEqual({ name: 'main', state: 'bound', actions: ['unread'], handle: 'opaque' });
  });
  it('refuses a supplied owner or chat and a different alias', async () => {
    await expect(appUnreadBinding('reader', { name: 'main', chatId: CHAT })).rejects.toThrow();
    await expect(appUnreadBinding('reader', { name: 'main', ownerId: state.owner })).rejects.toThrow();
    await expect(appUnreadBinding('reader', { name: 'other' })).rejects.toThrow();
  });
  it('denies an account change, revoked permission, changed target and lost membership', async () => {
    for (const change of [() => { state.owner = '22000000-0000-4000-8000-000000000002'; }, () => { state.allowed = false; }, () => { state.handle = 'replaced'; }]) {
      state.owner = '11000000-0000-4000-8000-000000000001'; state.allowed = true; state.handle = 'opaque'; state.afterMember = change;
      await expect(appUnreadBinding('reader', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
    }
    state.afterMember = undefined; state.allowed = true; state.member = false;
    await expect(appUnreadBinding('reader', { name: 'main' })).rejects.toMatchObject({ code: 'denied' });
  });
  it('does not save a selection for another account or a conversation without current membership', async () => {
    const input = { extensionId: 'reader', name: 'main', ownerId: state.owner, authority: AUTHORITY, chatId: CHAT };
    await expect(setUnreadBinding({ ...input, ownerId: '22000000-0000-4000-8000-000000000002' })).rejects.toThrow();
    state.member = false;
    await expect(setUnreadBinding(input)).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });
  it('requires the authority drawn by the common permission UI', async () => {
    await expect(setUnreadBinding({ extensionId: 'reader', name: 'main', ownerId: state.owner, chatId: CHAT })).rejects.toThrow();
    const choices = await unreadBindingChoices('reader', 'main');
    expect(choices.authority).toBe(AUTHORITY);
    await setUnreadBinding({ extensionId: 'reader', name: 'main', ownerId: state.owner, authority: choices.authority, chatId: CHAT });
    expect(set).toHaveBeenCalledExactlyOnceWith(state.owner, 'reader', 'main', CHAT);
  });
  it('refuses a stale selection before saving and an authority replacement during the membership read', async () => {
    const input = { extensionId: 'reader', name: 'main', ownerId: state.owner, authority: AUTHORITY, chatId: CHAT };
    state.authority = '55000000-0000-4000-8000-000000000005';
    await expect(setUnreadBinding(input)).rejects.toMatchObject({ code: 'denied' });
    state.authority = AUTHORITY;
    state.afterMember = () => { state.authority = '55000000-0000-4000-8000-000000000005'; };
    await expect(setUnreadBinding(input)).rejects.toMatchObject({ code: 'denied' });
    expect(set).not.toHaveBeenCalled();
  });
  it('does not display choices returned after the installed authority changes', async () => {
    state.afterChoices = () => { state.authority = '55000000-0000-4000-8000-000000000005'; };
    await expect(unreadBindingChoices('reader', 'main')).rejects.toMatchObject({ code: 'denied' });
  });
});
