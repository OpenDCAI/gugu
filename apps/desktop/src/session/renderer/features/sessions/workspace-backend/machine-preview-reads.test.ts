import { describe, expect, it, vi } from 'vitest';
import {
  answerMachinePreviewReads,
  type MachinePreviewReadRequest,
  type MachinePreviewReadResult,
} from './machine-preview-reads';

function setup(read: Parameters<typeof answerMachinePreviewReads>[0]['read']) {
  let handler: ((request: MachinePreviewReadRequest) => void) | null = null;
  const replies: MachinePreviewReadResult[] = [];
  const off = vi.fn();
  const stop = answerMachinePreviewReads({
    onRequest: (h) => {
      handler = h;
      return off;
    },
    reply: (result) => replies.push(result),
    read,
  });
  const ask = async (request: MachinePreviewReadRequest) => {
    handler!(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { ask, replies, stop, off };
}

const request: MachinePreviewReadRequest = {
  requestId: 'r1',
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  path: '/root/proj/style.css',
  offset: 0,
  length: 524288,
};

describe('answerMachinePreviewReads', () => {
  it('reads the chunk from the project’s machine and answers with it', async () => {
    const read = vi.fn(async () => ({ size: 3, etag: 'e', data: 'YWJj' }));
    const { ask, replies } = setup(read);
    await ask(request);
    expect(read).toHaveBeenCalledWith('proj-1', 'ws-1', { path: '/root/proj/style.css', offset: 0, length: 524288 });
    expect(replies).toEqual([{ requestId: 'r1', chunk: { size: 3, etag: 'e', data: 'YWJj' } }]);
  });

  it('answers every request, with the machine’s reason code when it refuses', async () => {
    const read = vi.fn(async () => {
      throw Object.assign(new Error('outside'), { code: 'outside_workspace' });
    });
    const { ask, replies } = setup(read);
    await ask(request);
    expect(replies).toEqual([{ requestId: 'r1', errorCode: 'outside_workspace' }]);
  });

  it('answers no_answer when the transport failed without a code (never leaves the host waiting)', async () => {
    const { ask, replies } = setup(vi.fn(async () => Promise.reject(new Error('link down'))));
    await ask(request);
    expect(replies).toEqual([{ requestId: 'r1', errorCode: 'no_answer' }]);
  });

  it('stops listening when stopped', () => {
    const { stop, off } = setup(vi.fn());
    stop();
    expect(off).toHaveBeenCalled();
  });
});
