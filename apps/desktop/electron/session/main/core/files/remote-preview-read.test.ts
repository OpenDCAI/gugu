import { describe, expect, it, vi } from 'vitest';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { readRemotePreviewBytes, remotePreviewFailureStatus, withUtf8Charset, type RemoteChunk } from './remote-preview-read';

/** 一份在那台机器上的文件:按 offset / length 切块回,etag 可在读到第 n 块时换掉(agent 正在写)。 */
function remoteFile(content: Buffer, options: { etags?: string[] } = {}) {
  let calls = 0;
  const read = vi.fn(async ({ offset, length }: { path: string; offset: number; length: number }): Promise<RemoteChunk> => {
    const etag = options.etags?.[calls] ?? 'e1';
    calls += 1;
    return { size: content.length, etag, data: content.subarray(offset, offset + length).toString('base64') };
  });
  return read;
}

describe('readRemotePreviewBytes', () => {
  it('reads a small file in one round trip', async () => {
    const read = remoteFile(Buffer.from('<h1>hi</h1>'));
    const result = await readRemotePreviewBytes(read, '/root/proj/a.html', 1024);
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe('<h1>hi</h1>');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ path: '/root/proj/a.html', offset: 0, length: REMOTE_WORKSPACE_CHUNK_BYTES });
  });

  it('stitches a file larger than one chunk in order', async () => {
    const content = Buffer.alloc(REMOTE_WORKSPACE_CHUNK_BYTES * 2 + 10, 7);
    content[REMOTE_WORKSPACE_CHUNK_BYTES] = 1;
    const read = remoteFile(content);
    const result = await readRemotePreviewBytes(read, '/p/big.bin', content.length);
    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.compare(Buffer.from(result.bytes), content)).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('refuses a file over the cap instead of serving half of it', async () => {
    const read = remoteFile(Buffer.alloc(2048));
    await expect(readRemotePreviewBytes(read, '/p/x.css', 1024)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('starts over when the file changes mid-read, and gives up if it keeps changing', async () => {
    const content = Buffer.alloc(REMOTE_WORKSPACE_CHUNK_BYTES + 5, 1);
    // 第一遍第二块换了版本 → 重读一遍成功。
    const settles = remoteFile(content, { etags: ['a', 'b', 'b', 'b'] });
    const ok = await readRemotePreviewBytes(settles, '/p/x.js', content.length * 2);
    expect(ok.ok).toBe(true);
    // 每一块都换版本 → 三遍后放弃,❌ 拼出两个版本各一半。
    const churns = remoteFile(content, { etags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    await expect(readRemotePreviewBytes(churns, '/p/x.js', content.length * 2)).resolves.toEqual({ ok: false, reason: 'changing' });
  });

  it('carries the machine’s reason when it refuses, and maps it to an honest status', async () => {
    const outside = vi.fn(async () => {
      throw Object.assign(new Error('outside'), { code: 'outside_workspace' });
    });
    const refused = await readRemotePreviewBytes(outside, '/etc/passwd', 1024);
    expect(refused).toEqual({ ok: false, reason: 'unreadable', code: 'outside_workspace' });
    expect(remotePreviewFailureStatus(refused as Extract<typeof refused, { ok: false }>)).toBe(403);
    expect(remotePreviewFailureStatus({ ok: false, reason: 'unreadable', code: 'not_found' })).toBe(404);
    expect(remotePreviewFailureStatus({ ok: false, reason: 'unreadable' })).toBe(404);
    expect(remotePreviewFailureStatus({ ok: false, reason: 'too_large' })).toBe(413);
  });

  it('decodes base64 exactly (binary assets survive)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const read = vi.fn(async () => ({ size: png.length, etag: 'e', data: png.toString('base64') }));
    const result = await readRemotePreviewBytes(read, '/p/a.png', 100);
    expect(result.ok && Array.from(result.bytes)).toEqual(Array.from(png));
  });

  it('does not start a read for an already cancelled operation', async () => {
    const operation = new AbortController();
    operation.abort();
    const read = remoteFile(Buffer.from('unused'));
    await expect(readRemotePreviewBytes(read, '/p/a.css', 1024, operation.signal)).resolves.toMatchObject({ ok: false, code: 'aborted' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops after a pending chunk is cancelled, including a changed etag (%s)', async (changed) => {
    const operation = new AbortController();
    let finish!: (chunk: RemoteChunk) => void;
    const first = { size: REMOTE_WORKSPACE_CHUNK_BYTES * 3, etag: 'old', data: Buffer.alloc(REMOTE_WORKSPACE_CHUNK_BYTES).toString('base64') };
    const read = vi.fn().mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<RemoteChunk>(resolve => { finish = resolve; }));
    const result = readRemotePreviewBytes(read, '/p/a.css', first.size, operation.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    operation.abort();
    finish({ ...first, etag: changed ? 'new' : 'old' });
    await expect(result).resolves.toMatchObject({ ok: false, code: 'aborted' });
    expect(read).toHaveBeenCalledTimes(2); // Neither the next offset nor an etag retry may start.
  });
});

describe('withUtf8Charset', () => {
  it('labels valid UTF-8 text so an unlabelled Chinese page is not garbled', () => {
    expect(withUtf8Charset('text/html', Buffer.from('<h1>第二页</h1>'))).toBe('text/html; charset=utf-8');
    expect(withUtf8Charset('text/css', Buffer.from('a{}'))).toBe('text/css; charset=utf-8');
  });

  it('leaves non-UTF-8 text (GBK) to its own declaration, and binary types alone', () => {
    expect(withUtf8Charset('text/html', Buffer.from([0xb5, 0xda, 0xb6, 0xfe]))).toBe('text/html');
    expect(withUtf8Charset('image/png', Buffer.from([0x89, 0x50]))).toBe('image/png');
  });
});
