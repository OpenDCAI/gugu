import { ok } from '@gugu/session-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestWire, deferred } from '../testing';
import { BLOB_IDLE_TIMEOUT_MS, blobSourceFromBytes } from './blob-channel';
import { defineContract, uploadFile } from './define';
import { forwardController } from './forward';

const contract = defineContract({
  upload: uploadFile({ input: z.object({}), result: z.number(), error: z.never() }),
});

afterEach(() => vi.useRealTimers());

describe('upload inactivity across a forwarding host (#995)', () => {
  it('reports real progress and permits a slow transfer that keeps moving', async () => {
    vi.useFakeTimers();
    const wire = createTestWire(contract, {
      upload: async (_input, file) => ok((await file.bytes()).byteLength),
    });
    const onProgress = vi.fn();
    const source = { async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, BLOB_IDLE_TIMEOUT_MS - 1000));
        yield new Uint8Array(64 * 1024);
      }
    } };
    try {
      const uploaded = wire.client.upload({}, {
        name: 'slow.png', mimeType: 'image/png', size: 3 * 64 * 1024, source,
      }, { onProgress });
      await vi.advanceTimersByTimeAsync(BLOB_IDLE_TIMEOUT_MS * 3);
      await expect(uploaded).resolves.toEqual(ok(3 * 64 * 1024));
      expect(onProgress.mock.calls.map(([value]) => value.sent)).toEqual([64 * 1024, 128 * 1024, 192 * 1024]);
    } finally { wire.dispose(); }
  });

  it('cancels the receiving upload reader when its caller cancels', async () => {
    const release = deferred();
    let handlerSettled = false;
    const wire = createTestWire(contract, {
      upload: async (_input, file) => {
        try { return ok((await file.bytes()).byteLength); }
        finally { handlerSettled = true; }
      },
    });
    const abort = new AbortController();
    const source = { async *[Symbol.asyncIterator]() { await release.promise; yield new Uint8Array(1); } };
    const uploaded = wire.client.upload({}, {
      name: 'cancel.png', mimeType: 'image/png', size: 1, source,
    }, { signal: abort.signal });
    const rejected = expect(uploaded).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      abort.abort();
      await rejected;
      // The cancellation travels through the real consumer, not just the caller's promise.
      await vi.waitFor(() => expect(handlerSettled).toBe(true));
    } finally { release.resolve(); wire.dispose(); }
  });

  it('rejects a stalled upload even when the upstream cannot answer yet', async () => {
    vi.useFakeTimers();
    const release = deferred();
    const upstream = createTestWire(contract, {
      upload: async (_input, file) => {
        await release.promise;
        return ok((await file.bytes()).byteLength);
      },
    });
    const forwarded = createTestWire(contract, forwardController(contract, upstream.client));
    let outcome: unknown = 'pending';
    const upload = forwarded.client.upload({}, {
      name: 'image.png', mimeType: 'image/png', size: 1_048_576,
      source: blobSourceFromBytes(new Uint8Array(1_048_576)),
    }).then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(BLOB_IDLE_TIMEOUT_MS + 1);
      expect(outcome).toMatchObject({ code: 'TIMEOUT' });
      release.resolve();
      await upload;
    } finally {
      release.resolve();
      forwarded.dispose();
      upstream.dispose();
    }
  });

  it('times out after progress stops, rather than disabling the timer on the first pull', async () => {
    vi.useFakeTimers();
    const release = deferred();
    const wire = createTestWire(contract, {
      upload: async (_input, file) => ok((await file.bytes()).byteLength),
    });
    let outcome: unknown = 'pending';
    const source = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(64 * 1024);
        await release.promise;
        yield new Uint8Array(64 * 1024);
      },
    };
    const upload = wire.client.upload({}, {
      name: 'partial.png', mimeType: 'image/png', size: 128 * 1024, source,
    }).then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(BLOB_IDLE_TIMEOUT_MS + 1);
      expect(outcome).toMatchObject({ code: 'TIMEOUT' });
      release.resolve();
      await upload;
    } finally {
      release.resolve();
      wire.dispose();
    }
  });
});
