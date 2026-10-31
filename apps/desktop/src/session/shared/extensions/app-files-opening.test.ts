import { beforeEach, expect, it, vi } from 'vitest';
import type { Grant } from './file-sync-core';

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const row = {
  id: ITEM, chat_id: CHAT, kind: 'document', filename: 'note.md', content_type: 'text/markdown',
  size_bytes: 50, created_at: null, updated_at: null, created_by: PERSON, updated_by: PERSON,
  source_message_ids: [], parent_id: null, system_role: null, path: 'note.md', epoch: 2, version: 3,
  pointer: 'must-not-cross', inline_text: 'DOCUMENT MUST NOT CROSS',
};
const rpc = vi.fn((name: string) => {
  const result = Promise.resolve({ data: name === 'workspace_deletable_as' ? [ITEM] : [row], error: null });
  return Object.assign(result, { select: vi.fn((_columns: string) => result) });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
const identities = vi.fn(async () => [{ id: PERSON, name: 'Creator', kind: 'human' as const, avatar: null }]);
const claimant = vi.fn(() => ({ suffix: '.md', app: { id: 'workspace', name: 'Folder', icon: null }, state: false }));
const warn = vi.fn();
const grant = vi.fn<(page: unknown, grant: Grant) => void>();
const ensureFor = vi.fn();
const page = { pageId: 7, extensionId: 'workspace', itemId: ITEM };
let files: ReturnType<typeof createAppFiles>;

beforeEach(() => {
  rpc.mockClear(); claimant.mockClear(); identities.mockClear(); warn.mockClear(); grant.mockClear(); ensureFor.mockClear();
  files = createAppFiles({
    account: async () => ({ token: 'token', userId: PERSON }), hasCapability: () => true,
    sync: { ensureFor, pageFor: () => ({}), grant, ungrant: vi.fn(), revoke: vi.fn() } as never,
    claimant, identities, faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn,
  });
});

it('hands the click authorization to the bound file without reading its row twice or carrying content', async () => {
  const target = await files.openTarget(page, { ref: { id: ITEM } });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as']);
  const columns = rpc.mock.results[0]!.value.select.mock.calls[0]![0].split(',');
  expect(columns).toContain('epoch');
  expect(columns).toContain('updated_by');
  expect(columns).not.toContain('inline_text');
  expect(claimant).not.toHaveBeenCalled();
  expect(JSON.stringify(target.opening)).not.toContain('must-not-cross');
  expect(JSON.stringify(target.opening)).not.toContain('DOCUMENT MUST NOT CROSS');
  const opened = await files.open(page, { ref: { chat: CHAT, id: ITEM }, expectedVersion: 3, deferDetails: true }, target.opening);
  expect(opened).toMatchObject({ docName: `${ITEM}@2`, access: 'rw', entry: { detailsPending: true, canDelete: false } });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as']);
  expect(claimant).toHaveBeenCalledOnce();
  expect(opened.entry.claimedBy).toMatchObject({ id: 'workspace' });
  // Only the sync identity is needed to render. Author/delete decoration waits for the page's acknowledgement.
  expect(identities).toHaveBeenCalledTimes(1);
  const decorated = await grant.mock.calls[0]![1].details!();
  expect(decorated).toMatchObject({ createdBy: { name: 'Creator' }, updatedBy: { name: 'Creator' }, canDelete: true });
  expect(decorated).not.toHaveProperty('detailsPending');
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as', 'workspace_deletable_as']);
  expect(warn).not.toHaveBeenCalled();
});

it('reads the existing sync identity alongside click authorization, then reuses it for the guest', async () => {
  let resolveRow!: (value: { data: typeof row[]; error: null }) => void;
  rpc.mockImplementationOnce(() => {
    const requested = new Promise<{ data: typeof row[]; error: null }>((resolve) => { resolveRow = resolve; });
    return Object.assign(requested, { select: vi.fn((_columns: string) => requested) });
  });
  const requested = files.openTarget(page, { ref: { id: ITEM } });
  await vi.waitFor(() => expect(identities).toHaveBeenCalledWith('token', [PERSON]));
  resolveRow({ data: [row], error: null });
  const target = await requested;
  await files.open(page, { ref: { chat: CHAT, id: ITEM }, deferDetails: true }, target.opening);
  expect(identities).toHaveBeenCalledOnce();
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as']);
});

it('starts the shared connection only after authorization, while the parallel identity read is pending', async () => {
  let resolveRow!: (value: { data: typeof row[]; error: null }) => void;
  rpc.mockImplementationOnce(() => {
    const requested = new Promise<{ data: typeof row[]; error: null }>((resolve) => { resolveRow = resolve; });
    return Object.assign(requested, { select: vi.fn((_columns: string) => requested) });
  });
  let identity!: (value: Awaited<ReturnType<typeof identities>>) => void;
  identities.mockImplementationOnce(() => new Promise((resolve) => { identity = resolve; }));
  const requested = files.openTarget(page, { ref: { id: ITEM } });
  await vi.waitFor(() => expect(identities).toHaveBeenCalled());
  expect(ensureFor).not.toHaveBeenCalled();
  resolveRow({ data: [row], error: null });
  await vi.waitFor(() => expect(ensureFor).toHaveBeenCalledWith(null));
  expect(grant).not.toHaveBeenCalled();
  identity([{ id: PERSON, name: 'Creator', kind: 'human', avatar: null }]);
  await requested;
});

it('does not start a connection when the file authorization is refused', async () => {
  const denied = Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } });
  rpc.mockImplementationOnce(() => Object.assign(denied, { select: vi.fn(() => denied) }) as never);
  await expect(files.openTarget(page, { ref: { id: ITEM } })).rejects.toThrow();
  expect(ensureFor).not.toHaveBeenCalled();
});

it('starts the same connection identity as the authorized agent opening', async () => {
  const agent = '22222222-2222-4222-8222-222222222222';
  const target = await files.openTarget({ ...page, asAgent: agent }, { ref: { id: ITEM } });
  expect(ensureFor).toHaveBeenCalledExactlyOnceWith(agent);
  expect(target.opening?.actor).toBe(agent);
});

it('does not extend the authorization lifetime while the parallel identity read is pending', async () => {
  let clock: number | undefined;
  const realNow = Date.now;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock ?? realNow());
  let snapshotRead = false;
  const metadata = { ...row, get epoch() { clock = 1_000; snapshotRead = true; return row.epoch; } };
  const requestedRow = Promise.resolve({ data: [metadata], error: null });
  rpc.mockImplementationOnce(() => Object.assign(requestedRow, { select: vi.fn((_columns: string) => requestedRow) }));
  let identity!: (value: Awaited<ReturnType<typeof identities>>) => void;
  identities.mockImplementationOnce(() => new Promise((resolve) => { identity = resolve; }));
  try {
    const requested = files.openTarget(page, { ref: { id: ITEM } });
    await vi.waitFor(() => expect(snapshotRead).toBe(true));
    clock = 7_000;
    identity([{ id: PERSON, name: 'Creator', kind: 'human', avatar: null }]);
    const target = await requested;
    expect(target.opening?.expiresAt).toBe(6_000);
    await files.open(page, { ref: { chat: CHAT, id: ITEM }, deferDetails: true }, target.opening);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as', 'workspace_get_as']);
    expect(warn).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); }
});

it.each(['expiry', 'version', 'actor', 'guest'] as const)('rechecks the original authorized reader on %s mismatch and records it', async (mismatch) => {
  const { opening } = await files.openTarget(page, { ref: { id: ITEM } });
  if (mismatch === 'expiry') opening!.expiresAt = 0;
  if (mismatch === 'actor') opening!.actor = 'another-person';
  const target = mismatch === 'guest' ? { ...page, itemId: null } : page;
  await files.open(target, { ref: { chat: CHAT, id: ITEM }, expectedVersion: mismatch === 'version' ? 4 : 3, deferDetails: true }, opening);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as', 'workspace_get_as']);
  expect(warn).toHaveBeenCalledOnce();
  expect(grant).toHaveBeenCalledOnce();
});

it('does not accept a prepared authorization supplied in the App request itself', async () => {
  const { opening } = await files.openTarget(page, { ref: { id: ITEM } });
  rpc.mockClear();
  const args = { ref: { id: ITEM }, deferDetails: true, opening };
  await files.open(page, args);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_get_as']);
});
