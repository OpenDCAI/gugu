/**
 * 任务输入框的附件 chip(P3,product spec):贴上来就开始放进私聊文件夹、进度在 chip 上、
 * 失败在 chip 上并可重试、× 掉取消、发送前等放完;私聊只问一次。
 */
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi';

const place = vi.fn();
const prepare = vi.fn();
vi.mock('@/lib/attachmentsEndpoint', () => ({
  placeTaskAttachment: (...args: unknown[]) => place(...args),
  prepareTaskAttachment: (...args: unknown[]) => prepare(...args),
}));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));

const { useComposerFileUploads } = await import('./use-composer-file-uploads');

type Hook = ReturnType<typeof useComposerFileUploads>;
let hook: Hook | null = null;
let chips: ComposerAttachment[] = [];
const to = vi.fn(async () => ({ chatId: 'dm-1', owner: 'owner-1' }));

function Probe() {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  chips = attachments;
  hook = useComposerFileUploads({ to, setAttachments, translate: ((key: string) => key) as never });
  return null;
}

const file = (name: string) => new File(['abc'], name, { type: 'text/plain' });
const ref = (id: string) => ({ itemId: id, version: 1, name: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 3 });

describe('useComposerFileUploads', () => {
  let dom: JSDOM;
  let root: Root;
  beforeEach(async () => {
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    place.mockReset();
    prepare.mockReset().mockResolvedValue(null);
    to.mockClear();
    root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(React.createElement(Probe)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('places on add, reports progress, asks for the DM once and hands back the refs in chip order', async () => {
    place.mockImplementation(async (f: File, _prepared: unknown, _to: unknown, onProgress: (sent: number, total: number) => void) => {
      onProgress(1, 3);
      return ref(f.name.replace('.txt', ''));
    });
    await act(async () => {
      void hook!.add({ id: 'b', name: 'b.txt', kind: 'file' }, file('b.txt'));
      void hook!.add({ id: 'a', name: 'a.txt', kind: 'file' }, file('a.txt'));
      await hook!.waitForUploads();
    });
    expect(to).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0]![2]).toEqual({ chatId: 'dm-1', owner: 'owner-1' });
    expect(chips.map((chip) => chip.state)).toEqual(['done', 'done']);
    expect(hook!.unsettled()).toBe(false);
    expect(hook!.files(['a', 'b']).map((f) => f.itemId)).toEqual(['a', 'b']);
  });

  it('a failure stays on the chip, blocks the send and can be retried', async () => {
    place.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ref('n'));
    let ok = true;
    await act(async () => {
      void hook!.add({ id: 'n', name: 'n.txt', kind: 'file' }, file('n.txt'));
      ok = await hook!.waitForUploads();
    });
    expect(ok).toBe(false);
    expect(chips[0]).toMatchObject({ state: 'error', retryable: true, meta: 'composer.attachmentUploadFailed' });
    await act(async () => {
      hook!.retry('n');
      ok = await hook!.waitForUploads();
    });
    expect(ok).toBe(true);
    expect(hook!.files(['n'])).toHaveLength(1);
  });

  it('× while placing cancels: the chip is no longer waited on and yields no ref', async () => {
    let finish: (value: unknown) => void = () => undefined;
    place.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      void hook!.add({ id: 'x', name: 'x.txt', kind: 'file' }, file('x.txt'));
    });
    const signal = place.mock.calls[0]![4].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    hook!.keepOnly(new Set());
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(ref('x')); });
    expect(await hook!.waitForUploads()).toBe(true);
    expect(hook!.files(['x'])).toEqual([]);
  });

  it('keeps the server size limit on the chip and does not offer a retry', async () => {
    const error = new AttachmentsError('upload', 413, 'too_large', 'This server accepts files up to 25 MiB');
    place.mockRejectedValue(error);
    await act(async () => { await hook!.add({ id: 'large', name: 'large.bin', kind: 'file' }, file('large.bin')); });
    expect(chips[0]).toMatchObject({ state: 'error', retryable: false, meta: 'composer.attachmentTooLarge' });
    expect(await hook!.waitForUploads()).toBe(false);
  });

  it('explains disabled transfers on the chip and allows retry after the setting changes', async () => {
    place.mockRejectedValueOnce(Object.assign(new Error('Cloud transfer is disabled for this file'), { code: 'transfer_disabled' }));
    await act(async () => { await hook!.add({ id: 'local', name: 'local.txt', kind: 'file' }, file('local.txt')); });
    expect(chips[0]).toMatchObject({ state: 'error', retryable: true, meta: 'composer.attachmentTransferDisabled' });
    place.mockResolvedValueOnce(ref('local'));
    await act(async () => { hook!.retry('local'); await hook!.waitForUploads(); });
    expect(chips[0]?.state).toBe('done');
  });

  it('retains publication progress across retries and clears it with the chip', async () => {
    const published = ref('published');
    place.mockImplementationOnce(async (_file, _prepared, _to, _progress, options) => {
      options.placement.published = published;
      throw new Error('prefetch offline');
    }).mockImplementationOnce(async (_file, _prepared, _to, _progress, options) => {
      expect(options.placement.published).toEqual(published);
      return published;
    });
    await act(async () => { await hook!.add({ id: 'published', name: 'published.txt', kind: 'file' }, file('published.txt')); });
    await act(async () => { hook!.retry('published'); await hook!.waitForUploads(); });
    expect(hook!.files(['published'])).toEqual([published]);
  });

  it('explains identity-free tasks without exposing raw host errors', async () => {
    place.mockRejectedValue(Object.assign(new Error('private agent lookup failed'), { code: 'task_identity_missing' }));
    await act(async () => { await hook!.add({ id: 'none', name: 'brief.txt', kind: 'file' }, file('brief.txt')); });
    expect(chips[0]).toMatchObject({ state: 'error', retryable: false, meta: 'composer.attachmentIdentityRequired' });
  });

  it('names each chip once (prepare before create reuses it when placing) and fails the batch when one cannot be named', async () => {
    prepare.mockImplementation(async (f: File) => ({ ...ref(f.name.replace('.txt', '')), path: `/local/${f.name}` }));
    place.mockImplementation(async (_f: File, prepared: unknown) => prepared);
    const a = file('a.txt');
    let named: unknown;
    await act(async () => { named = await hook!.prepare([{ id: 'a', file: a }]); });
    expect(named).toEqual([expect.objectContaining({ itemId: 'a', path: '/local/a.txt' })]);
    await act(async () => {
      void hook!.add({ id: 'a', name: 'a.txt', kind: 'file' }, a);
      await hook!.waitForUploads();
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0]![1]).toEqual(expect.objectContaining({ itemId: 'a', path: '/local/a.txt' }));
    expect(hook!.files(['a'])).toEqual([expect.objectContaining({ itemId: 'a' })]);
    prepare.mockResolvedValueOnce(null);
    await act(async () => { named = await hook!.prepare([{ id: 'b', file: file('b.txt') }]); });
    expect(named).toBeNull();
  });
});
