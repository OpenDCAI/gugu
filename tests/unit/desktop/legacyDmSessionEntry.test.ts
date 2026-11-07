import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pages: [] as unknown[][], binding: null as { agentUserId: string } | null, afters: [] as (string | undefined)[], filters: [] as unknown[][] }));
vi.mock('@/lib/supabase', () => {
  const request = () => {
    let after: string | undefined;
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      not: (...args: unknown[]) => { h.filters.push(args); return chain; },
      gt: (_column: string, value: string) => { after = value; return chain; },
      abortSignal: () => { h.afters.push(after); return Promise.resolve({ data: h.pages.shift() ?? [], error: null }); },
    };
    return chain;
  };
  return {
    chatDb: { from: request, rpc: () => ({ abortSignal: () => Promise.resolve({ data: [], error: null }) }) },
    identityDb: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ abortSignal: () => Promise.resolve({ data: [], error: null }) }) }) }) }) },
  };
});
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/lib/authSessionLoss', () => ({ currentAuthSessionSignal: () => new AbortController().signal }));
vi.mock('@/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: string[]) => ids.map(id => ({ id, type: 'agent', owner_user_id: 'owner', display_name: id })),
}));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionHistory: { legacyDmBinding: async () => h.binding } }),
}));
vi.mock('@/session/renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));

import { hasLegacyDmHistory } from '../../../apps/desktop/src/components/legacy-dm-history/data';

const dm = (id: string, peer: string) => ({ id, public_id: 1, name: null, created_at: 'then', last_message_at: 'then', members: [{ user_id: 'owner' }, { user_id: peer }] });
const fullPage = (peer: string, at: number) => Array.from({ length: 60 }, (_, index) => dm(`c${at}-${index}`, peer));

beforeEach(() => {
  h.pages = [];
  h.afters = [];
  h.filters = [];
  h.binding = { agentUserId: 'mine' };
});

it('a session with no verifiable identity has no history, and nothing is read for it', async () => {
  h.binding = null;
  expect(await hasLegacyDmHistory('owner', 'session')).toBe(false);
  expect(h.afters).toEqual([]);
});

it('a chat that never held a message is no history', async () => {
  expect(await hasLegacyDmHistory('owner', 'session')).toBe(false);
  expect(h.filters).toEqual([['last_message_at', 'is', null]]);
});

it("a full page of other agents' chats is not the end: the session's own is found on a later one", async () => {
  h.pages = [fullPage('other', 1), [dm('own', 'mine')]];
  expect(await hasLegacyDmHistory('owner', 'session')).toBe(true);
  expect(h.afters).toEqual([undefined, 'c1-59']);
});

it("only other agents' chats, to the last page: none", async () => {
  h.pages = [fullPage('other', 1), [dm('last', 'other')]];
  expect(await hasLegacyDmHistory('owner', 'session')).toBe(false);
});
