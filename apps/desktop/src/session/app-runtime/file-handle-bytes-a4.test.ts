import { describe, expect, it, vi } from 'vitest';
import { loadPage } from './fake-file-service';
import type { GuguHost } from './host';
import type { AppFileOpened } from '@shared/extensions/app-runtime-protocol';

type Handle = { type: string; text?: string; data?: Record<string, unknown>; size: number | null; bytes(): Promise<Uint8Array>; blob(): Promise<Blob>; close(): void | Promise<void>; read(offset: number, length: number): Promise<Uint8Array>; insert(index: number, text: string): void };

describe('every files.open handle has a byte view of the same content', () => {
  it('live text reports current UTF-8 size/bytes/blob after edits', async () => {
    const { open } = await loadPage<Handle>('text');
    const file = await open(); file.insert(0, '汉字🙂');
    const expected = new TextEncoder().encode(file.text!);
    expect(file.size).toBe(expected.byteLength);
    expect(await file.bytes()).toEqual(expected);
    expect(new Uint8Array(await (await file.blob()).arrayBuffer())).toEqual(expected);
    file.close();
  });
  it('live JSON uses the same two-space root serialization as create', async () => {
    const { open } = await loadPage<Handle>('json');
    const file = await open(); file.data!.title = '汉字'; file.data!.count = 2;
    const expected = new TextEncoder().encode(JSON.stringify({ title: '汉字', count: 2 }, null, 2));
    expect(await file.bytes()).toEqual(expected);
    expect(file.size).toBe(expected.byteLength);
    expect(new Uint8Array(await (await file.blob()).arrayBuffer())).toEqual(expected);
    file.close();
  });
  it.each(['application/octet-stream', 'text/plain'])('stored %s preserves its original byte view', async contentType => {
    vi.resetModules();
    const { openFile } = await import('./files-entry');
    const bytes = new TextEncoder().encode('hello汉字');
    const entry = { id: 'stored', name: contentType === 'text/plain' ? 'small.txt' : 'raw.bin', contentType, version: 1, size: bytes.length };
    const file = await openFile({} as GuguHost, Promise.resolve({ entry, bytes: bytes.buffer } as AppFileOpened)) as Handle;
    expect(file.type).toBe(contentType === 'text/plain' ? 'text' : 'binary');
    expect(await file.bytes()).toEqual(bytes); expect(file.size).toBe(bytes.length);
    expect(new Uint8Array(await (await file.blob()).arrayBuffer())).toEqual(bytes);
    if (file.type === 'binary') expect('text' in file).toBe(false);
    await file.close();
  });
  it.each([false, true])('one chunked implementation handles workspace=%s without inventing text', async workspace => {
    vi.resetModules();
    const { openFile } = await import('./files-entry');
    const bytes = Uint8Array.from({ length: 524300 }, (_, i) => i % 251);
    const read = vi.fn(async ({ offset, length }: { offset: number; length: number; ref: { version?: number } }) => ({ size: bytes.length, offset, data: bytes.slice(offset, offset + length) }));
    const close = vi.fn(async () => undefined);
    const entry = { id: 'chunks', name: 'data.bin', contentType: 'application/octet-stream', version: 3, size: workspace ? null : bytes.length, ...(workspace ? { workspace: 'session:test' } : {}) };
    const file = await openFile({ appFiles: { read, close } } as unknown as GuguHost, Promise.resolve({ entry, chunked: true } as AppFileOpened)) as Handle;
    expect(file.size).toBe(workspace ? null : bytes.length); expect('text' in file).toBe(false);
    expect(await file.read(12, 8)).toEqual(bytes.slice(12, 20)); expect(file.size).toBe(bytes.length);
    expect(await file.read(bytes.length - 3, 512)).toEqual(bytes.slice(-3));
    expect(await file.read(bytes.length, 4)).toEqual(new Uint8Array());
    expect(await file.read(0, 0)).toEqual(new Uint8Array());
    expect(await file.bytes()).toEqual(bytes);
    expect(new Uint8Array(await (await file.blob()).arrayBuffer())).toEqual(bytes);
    for (const [request] of read.mock.calls) {
      expect(request.length).toBeLessThanOrEqual(524288);
      expect(request.ref.version).toBe(workspace ? undefined : 3);
    }
    await file.close(); await file.close(); expect(close).toHaveBeenCalledTimes(1);
    await expect(file.read(0, 1)).rejects.toMatchObject({ code: 'failed' });
  });
});
