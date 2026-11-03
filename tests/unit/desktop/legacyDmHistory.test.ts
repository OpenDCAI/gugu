import { beforeEach, expect, it, vi } from 'vitest';
import { attachmentEnvelope, formatAttachmentMetadata } from '@gugu/core/shared/ui/attachmentModels';
import { messageItemFromRow } from '@gugu/core/cloud/messageItem';

const world = vi.hoisted(() => ({ owner: 'owner', calls: [] as { table: string; method: string; args: unknown[] }[],
  chats: [] as Record<string, unknown>[], messages: [] as Record<string, unknown>[], identities: [] as Record<string, unknown>[], markers: [] as { agent_user_id: string }[] }));
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    let single = false;
    const query = new Proxy({
      then(resolve: (result: { data: unknown; error: null }) => unknown) {
        const rows = table === 'chats' ? world.chats : table === 'messages_view' ? world.messages : world.markers;
        return Promise.resolve(resolve({ data: single ? rows[0] : rows, error: null }));
      },
    }, { get(target, key) {
      if (key === 'then') return target.then;
      return (...args: unknown[]) => { world.calls.push({ table, method: String(key), args }); if (key === 'single') single = true; return query; };
    } });
    world.calls.push({ table, method: 'from', args: [] });
    return query;
  };
  return { chatDb: { from }, identityDb: { from } };
});
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: world.owner } }) }));
vi.mock('@/lib/authSessionLoss', () => ({ currentAuthSessionSignal: () => new AbortController().signal }));
vi.mock('@/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => world.identities }));
const { readLegacyDmList, readLegacyDmMessages, mergeLegacyMessages } = await import('../../../apps/desktop/src/components/legacy-dm-history/data');
const { legacyMessageBody } = await import('../../../apps/desktop/src/components/legacy-dm-history/message-body');
const chat = (members: string[]) => ({ id: 'dm', public_id: 42, name: 'Old agent', created_at: '2026-10-01T00:00:00Z', last_message_at: null, members: members.map(user_id => ({ user_id })) });
const raw = (seq = 7) => ({ id: `message-${seq}`, chat_id: 'dm', sender_user_id: 'agent', seq, content: 'Original body', content_type: 'text', created_at: '2026-10-01T01:02:03Z' });
beforeEach(() => {
  world.owner = 'owner'; world.calls = []; world.markers = [];
  world.chats = [chat(['owner', 'agent'])]; world.messages = [raw()];
  world.identities = [{ id: 'agent', type: 'agent', owner_user_id: 'owner', display_name: 'Agent' }];
});
it('cross-checks owner, agent and both DM members before attaching history to a session', async () => {
  expect((await readLegacyDmList({ ownerUserId: 'owner', agentUserId: 'agent' })).rows).toHaveLength(1);
  world.identities[0].owner_user_id = 'another-owner';
  expect((await readLegacyDmList({ ownerUserId: 'owner', agentUserId: 'agent' })).rows).toEqual([]);
  world.identities[0].owner_user_id = 'owner'; world.chats = [chat(['stranger', 'agent'])];
  await expect(readLegacyDmMessages({ ownerUserId: 'owner', agentUserId: 'agent' }, 'dm')).rejects.toThrow(/not owned/);
});
it('keeps owner-only orphan DMs in the separate archive, never under a native binding', async () => {
  world.chats = [chat(['owner'])]; world.identities = [];
  expect((await readLegacyDmList({ ownerUserId: 'owner' })).rows).toHaveLength(1);
  expect((await readLegacyDmList({ ownerUserId: 'owner', agentUserId: 'agent' })).rows).toEqual([]);
});
it('excludes human conversations and the personal assistant using its provision marker', async () => {
  world.identities[0].type = 'human';
  expect((await readLegacyDmList({ ownerUserId: 'owner' })).rows).toEqual([]);
  world.identities[0].type = 'agent'; world.markers = [{ agent_user_id: 'agent' }];
  expect((await readLegacyDmList({ ownerUserId: 'owner' })).rows).toEqual([]);
});
it('pages original messages by sequence and retains their IDs, timestamps and file pins', async () => {
  world.messages = [raw(6), { ...raw(5), content_type: 'attachment', content: attachmentEnvelope('report.html', 12, 'text/html'), file_item_id: 'original-file', file_version: 3 }];
  const page = await readLegacyDmMessages({ ownerUserId: 'owner', agentUserId: 'agent' }, 'dm', 7);
  expect(page.rows.map(message => [message.id, message.seq, message.created_at])).toEqual([
    ['message-5', 5, '2026-10-01T01:02:03Z'], ['message-6', 6, '2026-10-01T01:02:03Z'],
  ]);
  expect(legacyMessageBody(page.rows[0], 'Retracted').files[0].source).toEqual({ kind: 'item', itemId: 'original-file', version: 3 });
  expect(world.calls).toContainEqual({ table: 'messages_view', method: 'lt', args: ['seq', 7] });
  expect(world.calls).toContainEqual({ table: 'messages_view', method: 'limit', args: [61] });
  expect(world.calls.some(call => ['insert', 'update', 'delete', 'upsert', 'rpc'].includes(call.method))).toBe(false);
  expect(mergeLegacyMessages(page.rows, [page.rows[1]])).toEqual(page.rows);
});
it('does not use a legacy body URL as authority for an attachment or restore a retracted body', () => {
  const message = messageItemFromRow({ ...raw(), content_type: 'attachment', content: formatAttachmentMetadata({ fileName: 'old.html', mimeType: 'text/html', kind: 'file', url: 'https://invalid.example/not-authority', sizeBytes: 12 }) }, 'owner')!;
  expect(legacyMessageBody(message, 'Retracted').files[0].source).toEqual({ kind: 'message', messageId: message.id });
  expect(legacyMessageBody({ ...message, retracted_at: '2026-10-02T00:00:00Z' }, 'Retracted')).toEqual({ text: 'Retracted', files: [], invalidAttachments: false });
});
it('refuses a stale account before issuing any query', async () => {
  world.owner = 'new-owner';
  await expect(readLegacyDmMessages({ ownerUserId: 'owner' }, 'dm')).rejects.toThrow(/account changed/);
  expect(world.calls).toEqual([]);
});
