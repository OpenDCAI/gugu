import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRPCClient, registerRPCRouter } from '@shared/lib/ipc/rpc';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('@main/core/extensions/account-token', () => ({
  currentAccountAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.y`,
}));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: async () => ({ v3: true }) } }));
vi.mock('./search-service', () => ({ searchService: {} }));
state.userData = mkdtempSync(join(tmpdir(), 'search-rpc-'));
const { searchController } = await import('./controller');
const { accountMessageSearch } = await import('./account-message-search');

afterAll(() => {
  accountMessageSearch.accountChanged(null);
  rmSync(state.userData, { recursive: true, force: true });
});

describe('search RPC through the real client and registered router', () => {
  it('writes the index with search.write and finds the row with search.global', async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>();
    registerRPCRouter({ search: searchController }, { handle: (channel, listener) => { handlers.set(channel, listener); } });
    const rpc = createRPCClient<{ search: typeof searchController }>(async (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      return handler({ sender: { id: 1 } }, ...args);
    });
    await rpc.search.write([
      { kind: 'chats', chats: [{ id: 'g', kind: 'group', sourceChatId: null }] },
      { kind: 'rows', rows: [{ id: 'm', chat_id: 'g', sender_user_id: 'peer', seq: 1, content: '发布计划', content_type: 'text', created_at: '2026-10-30T06:00:00Z' }] },
    ]);
    const found = await rpc.search.global({ query: { text: '发布', filters: {}, sort: 'recent' } });
    expect(found.results.map((hit) => hit.id)).toEqual(['m']);
  });
});
