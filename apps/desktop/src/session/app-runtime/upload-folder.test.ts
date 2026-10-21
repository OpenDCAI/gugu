import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

const CHAT = '33333333-3333-4333-8333-333333333333';

/**
 * 子文件夹: `gugu.files.upload({ chat, folder })` checks its folder as `files.list` and `files.create` do (`folderOf`): a
 * folder's path, its id as its entry gives it, or `''` the top. Anything else is `invalid` before the host is asked —
 * never the top by default, never another file's id.
 */
describe('gugu.files.upload: the folder it goes in', () => {
  const host = () => {
    const upload = vi.fn(async () => []);
    const gugu = createGugu(
      { appFiles: { upload, watch: vi.fn(async () => undefined) }, reportError: vi.fn(async () => undefined) } as never,
      { files: async () => ({}) as never },
    ) as unknown as { files: { upload: (place: unknown) => Promise<unknown> } };
    return { gugu, upload };
  };

  it('a path, a folder entry, \'\' — to the host as they are', async () => {
    const { gugu, upload } = host();
    await gugu.files.upload({ chat: CHAT, folder: '合同/2026' });
    await gugu.files.upload({ chat: CHAT, folder: { id: 'f1', type: 'folder' } });
    await gugu.files.upload({ chat: CHAT, folder: '' });
    await gugu.files.upload({ chat: CHAT });
    expect(upload.mock.calls.map((call) => (call as unknown as [{ folder?: string }])[0].folder)).toEqual(['合同/2026', 'f1', '', undefined]);
  });

  it('what is not a folder is invalid, and the host is not asked', async () => {
    const { gugu, upload } = host();
    for (const folder of [{ path: '合同' }, 42, { id: 'x1', type: 'binary' }]) {
      await expect(gugu.files.upload({ chat: CHAT, folder })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(upload).not.toHaveBeenCalled();
  });
});
