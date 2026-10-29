import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import { afterEach, expect, it, vi } from 'vitest';
import { composePromptText, fileMentionsFor } from './composer-file-paths';
import { enqueueImageAttachment, imagePromptAttachments } from './composer-image-attachments';

afterEach(() => vi.useRealTimers());

it.each(['TIMEOUT', 'DISCONNECTED'])('finishes preparation through the saved path after three %s attempts', async (code) => {
  vi.useFakeTimers();
  let attachments: ComposerAttachment[] = [];
  const refs = new Map();
  const paths = new Map([['chip', '/attachments/image.png']]);
  const upload = vi.fn().mockRejectedValue(Object.assign(new Error('worker unavailable'), { code }));
  const onRetry = vi.fn();
  const onFailure = vi.fn();
  let settled = false;
  const preparation = enqueueImageAttachment({ name: 'image.png', size: 1_048_576 } as File, 'image/png', {
    chipId: 'chip', update: change => { attachments = change(attachments); },
    readPreview: async () => undefined, upload, rememberRef: (id, ref) => refs.set(id, ref),
    onRetry, onFailure, fallback: { available: Promise.resolve(true), meta: '1 MB · Send as file path' },
    labels: { uploading: 'Uploading', failed: 'Failed' }, formatSize: () => '1 MB',
  }).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).toBe(true);
  await preparation;
  expect(upload).toHaveBeenCalledTimes(3);
  expect(new Set(upload.mock.calls.map(([, , options]) => options.uploadId)).size).toBe(1);
  expect(onRetry).toHaveBeenCalledTimes(2);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(attachments[0]).toMatchObject({ state: 'done', meta: '1 MB · Send as file path' });
  // sendWhenReady waits on preparation and then uses these same ledgers to queue the input.
  expect(attachments.some(attachment => attachment.state === 'error')).toBe(false);
  expect(imagePromptAttachments(attachments, refs)).toEqual([]);
  expect(composePromptText('read this', fileMentionsFor(attachments, paths))).toContain('/attachments/image.png');
});

it('waits for the durable path before completing a failed image upload', async () => {
  let attachments: ComposerAttachment[] = [];
  let savePath!: (available: boolean) => void;
  const available = new Promise<boolean>(resolve => { savePath = resolve; });
  let settled = false;
  const preparation = enqueueImageAttachment({ name: 'image.png', size: 1 } as File, 'image/png', {
    chipId: 'chip', update: change => { attachments = change(attachments); },
    readPreview: async () => undefined, upload: vi.fn().mockRejectedValue(new Error('rejected')),
    rememberRef: vi.fn(), fallback: { available, meta: 'Send as file path' },
    labels: { uploading: 'Uploading', failed: 'Failed' }, formatSize: String,
  }).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  savePath(true);
  await preparation;
  expect(attachments[0]).toMatchObject({ state: 'done', meta: 'Send as file path' });
});

it('retries a timed-out image without resubmitting the user prompt (#995)', async () => {
  vi.useFakeTimers();
  const file = { name: 'image.png', size: 1_048_576 } as File;
  let attachments: ComposerAttachment[] = [];
  const ref = { id: 'same-image', name: file.name, mimeType: 'image/png' as const };
  const upload = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('no transfer progress'), { code: 'TIMEOUT' }))
    .mockResolvedValueOnce(ref);
  const rememberRef = vi.fn();
  const result = enqueueImageAttachment(file, 'image/png', {
    chipId: 'chip', update: change => { attachments = change(attachments); },
    readPreview: async () => 'data:image/png;base64,preview', upload, rememberRef,
    labels: { uploading: 'Uploading', failed: 'Failed' }, formatSize: () => '1 MB',
  });
  const settled = result.then(() => 'done', () => 'rejected');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await settled).toBe('done');
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[1]?.[2].uploadId).toBe(upload.mock.calls[0]?.[2].uploadId);
  expect(rememberRef).toHaveBeenCalledExactlyOnceWith('chip', ref);
  expect(attachments).toEqual([expect.objectContaining({ id: 'chip', state: 'done', previewUrl: 'data:image/png;base64,preview' })]);
});

it('stops retrying when the image is removed', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const upload = vi.fn().mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'DISCONNECTED' }));
  const rememberRef = vi.fn();
  const result = enqueueImageAttachment({ name: 'cancel.png', size: 1 } as File, 'image/png', {
    chipId: 'cancel', update: () => {}, readPreview: async () => undefined,
    upload, rememberRef, signal: controller.signal,
    labels: { uploading: 'Uploading', failed: 'Failed' }, formatSize: String,
  });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await result;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(rememberRef).not.toHaveBeenCalled();
});

it('reports a permanent rejection without repeating it', async () => {
  let attachments: ComposerAttachment[] = [];
  const upload = vi.fn().mockRejectedValue(new Error('invalid image'));
  await enqueueImageAttachment({ name: 'bad.png', size: 1 } as File, 'image/png', {
    chipId: 'bad', update: change => { attachments = change(attachments); },
    readPreview: async () => undefined, upload, rememberRef: vi.fn(),
    labels: { uploading: 'Uploading', failed: 'Failed' }, formatSize: String,
  });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(attachments[0]).toMatchObject({ state: 'error', meta: 'Failed' });
});
