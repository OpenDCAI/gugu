/**
 * 输入框附件按块收下(#6264):续写要对得上偏移、名字逃不出这次上传的目录、传齐了落成与一次性存一份同样的记录、
 * × 掉清干净。
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ inserted: [] as unknown[] }));

vi.mock('electron', () => ({
  app: { getPath: () => '/should-not-be-used' },
  clipboard: {},
  nativeImage: {},
}));

vi.mock('@main/db/client', () => ({
  db: {
    insert: () => ({
      values: (rows: unknown) => {
        mocks.inserted.push(rows);
        return Promise.resolve();
      },
    }),
  },
}));

const { AttachmentUploadError, commitSessionAttachmentUpload, discardSessionAttachmentUpload, writeSessionAttachmentChunk } = await import(
  './attachment-upload'
);
const { sessionAttachmentDirectory } = await import('./session-attachment-store');

let userData = '';
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'gugu-attachment-upload-'));
  mocks.inserted = [];
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('attachment upload (chunked)', () => {
  it('appends chunks by offset and commits a file with the same record as a one-shot stage', async () => {
    const base = { sessionId: 'session-1', uploadId: 'upload-0001', segments: ['notes.txt'], total: 11 };
    await writeSessionAttachmentChunk({ ...base, offset: 0, data: bytes('hello ') }, userData);
    await writeSessionAttachmentChunk({ ...base, offset: 6, data: bytes('world') }, userData);
    const staged = await commitSessionAttachmentUpload(
      { sessionId: 'session-1', uploadId: 'upload-0001', kind: 'file', name: 'notes.txt', mimeType: 'text/plain' },
      userData
    );
    expect(await readFile(staged.storedPath, 'utf8')).toBe('hello world');
    expect(staged.mentionPath).toBe(staged.storedPath);
    expect(staged.storedPath.startsWith(sessionAttachmentDirectory('session-1', userData))).toBe(true);
    expect(mocks.inserted).toHaveLength(1);
    // 传了一半的那一格清掉了。
    expect(existsSync(join(sessionAttachmentDirectory('session-1', userData), '.incoming', 'upload-0001'))).toBe(false);
  });

  it('keeps the user’s own path as the mention target and can stage without recording', async () => {
    const base = { sessionId: 'session-1', uploadId: 'upload-0002', segments: ['a.md'], total: 1 };
    await writeSessionAttachmentChunk({ ...base, offset: 0, data: bytes('x') }, userData);
    const staged = await commitSessionAttachmentUpload(
      { sessionId: 'session-1', uploadId: 'upload-0002', kind: 'file', name: 'a.md', originalPath: '/Users/me/a.md', record: false },
      userData
    );
    expect(staged.mentionPath).toBe('/Users/me/a.md');
    expect(mocks.inserted).toHaveLength(0);
  });

  it('refuses a chunk whose offset does not continue the file', async () => {
    const base = { sessionId: 'session-1', uploadId: 'upload-0003', segments: ['a'], total: 10 };
    await writeSessionAttachmentChunk({ ...base, offset: 0, data: bytes('abc') }, userData);
    await expect(writeSessionAttachmentChunk({ ...base, offset: 5, data: bytes('d') }, userData)).rejects.toMatchObject({
      code: 'offset_mismatch',
    });
  });

  it('keeps names inside the upload directory', async () => {
    for (const segments of [['..', 'escape'], ['a/b'], [''], ['.']]) {
      await expect(
        writeSessionAttachmentChunk({ sessionId: 'session-1', uploadId: 'upload-0004', segments, offset: 0, data: bytes('x'), total: 1 }, userData)
      ).rejects.toBeInstanceOf(AttachmentUploadError);
    }
    await expect(
      writeSessionAttachmentChunk({ sessionId: 'session-1', uploadId: '../x', segments: ['a'], offset: 0, data: bytes('x'), total: 1 }, userData)
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a file over the attachment limit', async () => {
    await expect(
      writeSessionAttachmentChunk(
        { sessionId: 'session-1', uploadId: 'upload-0005', segments: ['a'], offset: 0, data: bytes('x'), total: 51 * 1024 * 1024 },
        userData
      )
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('commits a folder under its own name, one id deep', async () => {
    const write = (segments: string[], text: string) =>
      writeSessionAttachmentChunk(
        { sessionId: 'session-1', uploadId: 'upload-0006', segments, offset: 0, data: bytes(text), total: bytes(text).byteLength },
        userData
      );
    await write(['site', 'index.html'], '<p>');
    await write(['site', 'css', 'a.css'], 'a{}');
    const staged = await commitSessionAttachmentUpload({ sessionId: 'session-1', uploadId: 'upload-0006', kind: 'folder', name: 'site' }, userData);
    expect(staged.storedPath.endsWith('/site')).toBe(true);
    expect(staged.mimeType).toBe('inode/directory');
    expect(staged.size).toBe(6);
    expect((await readdir(staged.storedPath)).sort()).toEqual(['css', 'index.html']);
    expect(await readFile(join(staged.storedPath, 'css', 'a.css'), 'utf8')).toBe('a{}');
  });

  it('says nothing was uploaded when committing an unknown id', async () => {
    await expect(
      commitSessionAttachmentUpload({ sessionId: 'session-1', uploadId: 'upload-0007', kind: 'file', name: 'a' }, userData)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('discards what a cancelled upload already sent', async () => {
    await writeSessionAttachmentChunk(
      { sessionId: 'session-1', uploadId: 'upload-0008', segments: ['a'], offset: 0, data: bytes('x'), total: 2 },
      userData
    );
    await discardSessionAttachmentUpload({ sessionId: 'session-1', uploadId: 'upload-0008' }, userData);
    expect(existsSync(join(sessionAttachmentDirectory('session-1', userData), '.incoming', 'upload-0008'))).toBe(false);
  });
});
