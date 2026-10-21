import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentUploadCancelled,
  AttachmentUploadFailure,
  uploadComposerAttachment,
  type AttachmentUploadRpc,
  type UploadSource,
} from './composer-file-upload';

function bytesSource(name: string, bytes: Uint8Array, extra: Partial<Extract<UploadSource, { kind: 'file' }>> = {}): UploadSource {
  return { kind: 'file', name, size: bytes.byteLength, slice: async (start, end) => bytes.slice(start, end), ...extra };
}

function fakeRpc(overrides: Partial<AttachmentUploadRpc> = {}) {
  const written: { segments: string[]; offset: number; length: number; total: number }[] = [];
  const rpc: AttachmentUploadRpc = {
    writeAttachmentChunk: vi.fn(async (chunk) => {
      written.push({ segments: chunk.segments, offset: chunk.offset, length: chunk.data.byteLength, total: chunk.total });
      return { success: true as const, data: { received: chunk.offset + chunk.data.byteLength } };
    }),
    commitAttachmentUpload: vi.fn(async (commit) => ({
      success: true as const,
      data: {
        id: 'a1',
        storedPath: `/remote/att/${commit.name}`,
        mentionPath: commit.originalPath ?? `/remote/att/${commit.name}`,
        name: commit.name,
        size: 0,
      },
    })),
    discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
    ...overrides,
  };
  return { rpc, written };
}

describe('uploadComposerAttachment', () => {
  it('sends a file in chunks with offsets, reports progress, and returns the machine-side path', async () => {
    const { rpc, written } = fakeRpc();
    const progress: number[] = [];
    const committed = await uploadComposerAttachment({
      rpc,
      sessionId: 'session-1',
      uploadId: 'upload-0001',
      source: bytesSource('notes.txt', new Uint8Array(10)),
      chunkBytes: 4,
      onProgress: (sent) => progress.push(sent),
    });
    expect(written.map((w) => [w.offset, w.length])).toEqual([[0, 4], [4, 4], [8, 2]]);
    expect(written.every((w) => w.total === 10 && w.segments[0] === 'notes.txt')).toBe(true);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(committed.mentionPath).toBe('/remote/att/notes.txt');
    expect(rpc.discardAttachmentUpload).not.toHaveBeenCalled();
  });

  it('writes an empty file once, so it exists on the machine', async () => {
    const { rpc, written } = fakeRpc();
    await uploadComposerAttachment({ rpc, sessionId: 's', uploadId: 'upload-0001', source: bytesSource('empty', new Uint8Array(0)) });
    expect(written).toEqual([{ segments: ['empty'], offset: 0, length: 0, total: 0 }]);
  });

  it('passes the user’s own path and the stage-only flag through to the commit', async () => {
    const { rpc } = fakeRpc();
    await uploadComposerAttachment({
      rpc,
      sessionId: 's',
      uploadId: 'upload-0001',
      source: bytesSource('a.md', new Uint8Array(1), { originalPath: '/Users/me/a.md', mimeType: 'text/markdown' }),
      record: false,
    });
    expect(rpc.commitAttachmentUpload).toHaveBeenCalledWith({
      sessionId: 's',
      uploadId: 'upload-0001',
      kind: 'file',
      name: 'a.md',
      mimeType: 'text/markdown',
      originalPath: '/Users/me/a.md',
      record: false,
    });
  });

  it('sends every file of a folder under the folder name, then commits the folder', async () => {
    const { rpc, written } = fakeRpc();
    const piece = (segments: string[], size: number) => ({ segments, size, slice: async (s: number, e: number) => new Uint8Array(e - s) });
    await uploadComposerAttachment({
      rpc,
      sessionId: 's',
      uploadId: 'upload-0001',
      source: { kind: 'folder', name: 'site', pieces: [piece(['site', 'index.html'], 3), piece(['site', 'css', 'a.css'], 2)] },
    });
    expect(written.map((w) => w.segments.join('/'))).toEqual(['site/index.html', 'site/css/a.css']);
    expect(rpc.commitAttachmentUpload).toHaveBeenCalledWith({ sessionId: 's', uploadId: 'upload-0001', kind: 'folder', name: 'site' });
  });

  it('refuses over the limit before sending a byte (not retryable)', async () => {
    const { rpc } = fakeRpc();
    const failure = await uploadComposerAttachment({
      rpc,
      sessionId: 's',
      uploadId: 'upload-0001',
      source: bytesSource('big', new Uint8Array(11)),
      maxBytes: 10,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AttachmentUploadFailure);
    expect((failure as AttachmentUploadFailure).reason).toBe('too-large');
    expect((failure as AttachmentUploadFailure).retryable).toBe(false);
    expect(rpc.writeAttachmentChunk).not.toHaveBeenCalled();
  });

  it('calls a server that does not know the verb too old, and cleans up', async () => {
    const { rpc } = fakeRpc({
      writeAttachmentChunk: vi.fn(async () => {
        throw new Error("No handler registered for 'tasks.writeAttachmentChunk'");
      }),
    });
    const failure = await uploadComposerAttachment({ rpc, sessionId: 's', uploadId: 'upload-0001', source: bytesSource('a', new Uint8Array(1)) }).catch(
      (error: unknown) => error
    );
    expect((failure as AttachmentUploadFailure).reason).toBe('server-too-old');
    expect((failure as AttachmentUploadFailure).retryable).toBe(true);
    expect(rpc.discardAttachmentUpload).toHaveBeenCalledWith({ sessionId: 's', uploadId: 'upload-0001' });
  });

  it('turns a machine-side refusal into a failure with its reason', async () => {
    const { rpc } = fakeRpc({
      commitAttachmentUpload: vi.fn(async () => ({ success: false as const, error: { type: 'too_many_files', message: 'more than 10000 files' } })),
    });
    const failure = await uploadComposerAttachment({ rpc, sessionId: 's', uploadId: 'upload-0001', source: bytesSource('a', new Uint8Array(1)) }).catch(
      (error: unknown) => error
    );
    expect((failure as AttachmentUploadFailure).reason).toBe('too-large');
  });

  it('stops on cancel and discards what was sent', async () => {
    const controller = new AbortController();
    const { rpc } = fakeRpc({
      writeAttachmentChunk: vi.fn(async (chunk) => {
        controller.abort();
        return { success: true as const, data: { received: chunk.offset + chunk.data.byteLength } };
      }),
    });
    const error = await uploadComposerAttachment({
      rpc,
      sessionId: 's',
      uploadId: 'upload-0001',
      source: bytesSource('a', new Uint8Array(8)),
      chunkBytes: 4,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentUploadCancelled);
    expect(rpc.writeAttachmentChunk).toHaveBeenCalledTimes(1);
    expect(rpc.commitAttachmentUpload).not.toHaveBeenCalled();
    expect(rpc.discardAttachmentUpload).toHaveBeenCalled();
  });
});
