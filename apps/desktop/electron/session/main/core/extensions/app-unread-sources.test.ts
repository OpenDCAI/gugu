import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FILTER_CHUNK } from '@gugu/core/shared/inChunks';
import type { StoredUnreadBinding } from '@shared/extensions/unread-binding';

const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '22000000-0000-4000-8000-000000000002';
const state = vi.hoisted(() => ({
  owner: '',
  apps: [] as { id: string; source: boolean; enabled: boolean; allowed: boolean; binding: StoredUnreadBinding | null }[],
  active: [] as string[],
  error: false,
  afterRead: undefined as (() => void) | undefined,
}));
const membership = vi.hoisted(() => vi.fn());
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.owner }));
vi.mock('./app-files', () => ({ unreadBindingChatChoices: async () => [] }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({
  list: () => ({ extensions: state.apps.map(app => ({ manifest: {
    id: app.id, contributes: { unreadSource: app.source ? { binding: 'main' } : undefined },
  } })) }),
  isEnabled: (id: string) => state.apps.find(app => app.id === id)?.enabled,
  hasCapability: (id: string, capability: string) => capability === 'chat:unread' && state.apps.find(app => app.id === id)?.allowed,
  conversationUnreadBinding: (_owner: string, id: string) => {
    const app = state.apps.find(app => app.id === id);
    if (!app?.allowed || !app.enabled || !app.source) throw Object.assign(new Error('Denied'), { code: 'denied' });
    return app.binding;
  },
}) }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: (table: string) => {
  let owner: string;
  const query = {
    select: (columns: string) => { expect(columns).toBe('chat_id'); return query; },
    eq: (column: string, value: string) => { expect(column).toBe('user_id'); owner = value; return query; },
    in: async (column: string, ids: string[]) => {
      membership(table, owner, column, ids);
      const result = { data: ids.filter(id => state.active.includes(id)).map(chat_id => ({ chat_id })), error: state.error ? {} : null };
      state.afterRead?.();
      return result;
    },
  };
  return query;
} }) }));
const { grantedUnreadBindings } = await import('./app-unread-bindings');

function add(id: string, chatId: string) {
  const app = { id, source: true, enabled: true, allowed: true, binding: {
    ownerId: OWNER, name: 'main', chatId, handle: `${id}-handle`,
  } as StoredUnreadBinding | null };
  state.apps.push(app);
  return app;
}
beforeEach(() => {
  state.owner = OWNER; state.apps = []; state.active = []; state.error = false; state.afterRead = undefined;
  membership.mockReset();
});

describe('host unread source authority', () => {
  it('checks only declared, enabled grants and excludes a departed conversation without hiding another grant', async () => {
    const first = add('first', 'active');
    add('same-target', 'active');
    add('departed', 'left');
    add('page-only', 'page').source = false;
    add('disabled', 'disabled').enabled = false;
    add('revoked', 'revoked').allowed = false;
    add('unbound', 'unbound').binding = null;
    state.active = ['active'];
    expect(await grantedUnreadBindings(OWNER)).toEqual({ first: first.binding, 'same-target': state.apps[1].binding });
    expect(membership).toHaveBeenCalledExactlyOnceWith('active_members', OWNER, 'chat_id', ['active', 'left']);
  });

  it('bounds membership requests with the shared chunk budget', async () => {
    for (let index = 0; index < IN_FILTER_CHUNK + 1; index++) {
      const chatId = `chat-${index}`;
      add(`app-${index}`, chatId); state.active.push(chatId);
    }
    expect(Object.keys(await grantedUnreadBindings(OWNER))).toHaveLength(IN_FILTER_CHUNK + 1);
    expect(membership.mock.calls.map(call => call[3].length)).toEqual([IN_FILTER_CHUNK, 1]);
  });

  it('refuses a different account before querying and a changed account after the read', async () => {
    add('reader', 'active'); state.active = ['active'];
    await expect(grantedUnreadBindings(OTHER_OWNER)).rejects.toMatchObject({ code: 'denied' });
    expect(membership).not.toHaveBeenCalled();
    state.afterRead = () => { state.owner = OTHER_OWNER; };
    await expect(grantedUnreadBindings(OWNER)).rejects.toMatchObject({ code: 'denied' });
  });

  it('does not publish a revoked, disabled or replaced grant after the asynchronous check', async () => {
    const revoked = add('revoked', 'active');
    const disabled = add('disabled', 'active');
    const replaced = add('replaced', 'active');
    state.active = ['active'];
    state.afterRead = () => {
      revoked.allowed = false; disabled.enabled = false;
      replaced.binding = { ...replaced.binding!, chatId: 'other', handle: 'new-handle' };
    };
    expect(await grantedUnreadBindings(OWNER)).toEqual({});
  });

  it('keeps a verification failure distinct from confirmed absence and skips the network for no grants', async () => {
    expect(await grantedUnreadBindings(OWNER)).toEqual({});
    expect(membership).not.toHaveBeenCalled();
    add('reader', 'active'); state.error = true;
    await expect(grantedUnreadBindings(OWNER)).rejects.toMatchObject({ code: 'failed' });
  });
});
