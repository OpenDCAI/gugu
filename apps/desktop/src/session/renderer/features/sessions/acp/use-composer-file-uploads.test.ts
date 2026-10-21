/**
 * 输入框里文件附件那一排 chip(#6264,product spec):贴上来就开始传、进度在 chip 上、
 * 失败在 chip 上说原因并可重试、× 掉取消、发送前等传完。
 */
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { AttachmentUploadRpc, UploadSource } from './composer-file-upload';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessionCreate: {} } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));

const { useComposerFileUploads, progressMeta } = await import('./use-composer-file-uploads');

type Hook = ReturnType<typeof useComposerFileUploads>;
let hook: Hook | null = null;
let chips: ComposerAttachment[] = [];
const uploaded = new Map<string, string>();
let device: string | null = 'Linux 2';

const translate = (key: string, values?: Record<string, string | number>) =>
  `${key}${values ? JSON.stringify(values) : ''}`;

function Probe({ uploadRpc }: { uploadRpc: AttachmentUploadRpc }) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  chips = attachments;
  hook = useComposerFileUploads({
    sessionId: () => 'conv-1',
    deviceLabel: () => device,
    setAttachments,
    onUploaded: (chipId, committed) => uploaded.set(chipId, committed.mentionPath),
    translate: translate as never,
    uploadRpc,
  });
  return null;
}

function source(size: number): UploadSource {
  return { kind: 'file', name: 'notes.txt', size, slice: async (start, end) => new Uint8Array(end - start) };
}

function deferredRpc() {
  const gates: Array<() => void> = [];
  let failNext = false;
  const rpc: AttachmentUploadRpc = {
    writeAttachmentChunk: vi.fn(
      (chunk: { offset: number; data: Uint8Array }) =>
        new Promise<{ success: true; data: { received: number } }>((resolve, reject) => {
          gates.push(() => {
            if (failNext) {
              failNext = false;
              reject(new Error('connection lost'));
            } else resolve({ success: true, data: { received: chunk.offset + chunk.data.byteLength } });
          });
        })
    ),
    commitAttachmentUpload: vi.fn(async (commit) => ({
      success: true as const,
      data: { id: 'a', storedPath: `/m/${commit.name}`, mentionPath: `/m/${commit.name}`, name: commit.name, size: 1 },
    })),
    discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
  };
  return {
    rpc,
    release: async () => {
      await act(async () => {
        while (gates.length > 0) gates.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    failNextChunk: () => {
      failNext = true;
    },
  };
}

describe('useComposerFileUploads', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    uploaded.clear();
    device = 'Linux 2';
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('shows the chip at once as uploading with progress, then done with the machine path recorded', async () => {
    const io = deferredRpc();
    await act(async () => root.render(React.createElement(Probe, { uploadRpc: io.rpc })));
    let settled: Promise<boolean> | undefined;
    await act(async () => {
      settled = hook!.add({ id: 'c1', name: 'notes.txt', kind: 'file' }, source(10));
    });
    expect(chips[0]).toMatchObject({ id: 'c1', state: 'uploading', cancelable: true, meta: progressMeta(0, 10) });
    expect(hook!.unsettled()).toBe(true);
    await io.release();
    expect(await settled).toBe(true);
    expect(chips[0]).toMatchObject({ state: 'done' });
    expect(uploaded.get('c1')).toBe('/m/notes.txt');
    expect(hook!.unsettled()).toBe(false);
    expect(await hook!.waitForUploads()).toBe(true);
  });

  it('fails on the chip naming the machine, retries on request, and send waits for it', async () => {
    const io = deferredRpc();
    await act(async () => root.render(React.createElement(Probe, { uploadRpc: io.rpc })));
    await act(async () => {
      void hook!.add({ id: 'c1', name: 'notes.txt', kind: 'file' }, source(10));
    });
    io.failNextChunk();
    await io.release();
    expect(chips[0]).toMatchObject({ state: 'error', retryable: true, meta: 'composer.attachmentFailedOn{"device":"Linux 2"}' });
    expect(await hook!.waitForUploads()).toBe(false);
    expect(io.rpc.discardAttachmentUpload).toHaveBeenCalled();

    await act(async () => hook!.retry('c1'));
    expect(chips[0]).toMatchObject({ state: 'uploading' });
    const waiting = hook!.waitForUploads();
    await io.release();
    expect(await waiting).toBe(true);
    expect(chips[0]).toMatchObject({ state: 'done' });
  });

  it('says a too-large file on the chip without offering a retry', async () => {
    const io = deferredRpc();
    await act(async () => root.render(React.createElement(Probe, { uploadRpc: io.rpc })));
    await act(async () => {
      await hook!.add({ id: 'c1', name: 'big', kind: 'file' }, source(51 * 1024 * 1024));
    });
    expect(chips[0]).toMatchObject({ state: 'error', retryable: false });
    expect(chips[0]!.meta).toContain('composer.attachmentTooLarge');
    expect(io.rpc.writeAttachmentChunk).not.toHaveBeenCalled();
  });

  it('cancels an upload whose chip was removed (and cleans up what was sent)', async () => {
    const io = deferredRpc();
    await act(async () => root.render(React.createElement(Probe, { uploadRpc: io.rpc })));
    let settled: Promise<boolean> | undefined;
    await act(async () => {
      settled = hook!.add({ id: 'c1', name: 'notes.txt', kind: 'file' }, source(10));
    });
    act(() => hook!.keepOnly(new Set()));
    await io.release();
    expect(await settled).toBe(false);
    expect(uploaded.has('c1')).toBe(false);
    expect(io.rpc.commitAttachmentUpload).not.toHaveBeenCalled();
    expect(io.rpc.discardAttachmentUpload).toHaveBeenCalled();
    expect(hook!.busy()).toBe(false);
  });
});
