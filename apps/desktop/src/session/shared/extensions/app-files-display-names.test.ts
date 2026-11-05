import { describe, expect, it, vi } from 'vitest';
import { claimantOf } from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const examples = [
  ['群公告.md', 'text/markdown', '群公告.md'],
  ['group-meta.json', 'application/json', 'group-meta.json'],
  ['todo.txt', 'text/plain', 'todo.txt'],
  ['banner.png', 'image/png', 'banner.png'],
  ['x.vote.json', 'application/json', 'x'],
] as const;
const rows = examples.map(([filename, content_type], index) => ({
  id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`, chat_id: CHAT,
  kind: 'file', filename, content_type, size_bytes: 10, version: 1, epoch: 0,
  created_at: null, updated_at: null, created_by: null, updated_by: null,
  source_message_ids: [], parent_id: null, system_role: null, path: filename,
}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
rpc.mockImplementation((name: string) => {
  const result = Promise.resolve({ data: name === 'workspace_deletable_as' ? rows.map(row => row.id) : rows, error: null });
  return Object.assign(result, { select: () => result });
});
const { createAppFiles } = await import('./app-files-core');
const manifest = (id: string, suffixes: string[]) => parseExtensionManifest({
  id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: id, opensFiles: { chat: suffixes } }] },
});
const apps = [manifest('workspace', ['.md', '.json']), manifest('vote', ['.vote.json'])];
const files = createAppFiles({
  account: async () => ({ token: 'test-token', userId: PERSON }), hasCapability: () => true,
  sync: { ensureFor: vi.fn(), pageFor: () => ({}), grant: vi.fn(), revoke: vi.fn(), ungrant: vi.fn() } as never,
  claimant: name => {
    const claim = claimantOf(name, apps, 'chat', () => null);
    return claim ? { suffix: claim.suffix, app: { id: claim.extensionId, name: claim.app.name, icon: null }, state: claim.state } : null;
  },
  identities: async () => [], faces: async () => ({}), filesUrl: () => 'https://files.invalid', warn: vi.fn(),
});

describe('Folder list names use the shared display rule and preserve stored file identity', () => {
  it.each(examples)('%s retains its expected display name', async (name, _contentType, expected) => {
    const entry = (await files.groupFiles(CHAT)).find(entry => entry.name === name);
    expect(entry).toMatchObject({ name, path: name, displayName: expected });
  });
});
