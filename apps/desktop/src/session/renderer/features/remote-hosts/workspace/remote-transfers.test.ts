import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_WORKSPACE_CHUNK_BYTES,
  REMOTE_WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_WRITE_FORCE,
  type SessionpageWorkspaceEntry,
  type SessionpageWorkspaceWriteRequest,
} from '@gugu/session-core/session-record/contract';
import { RemoteTransfers, type DownloadSink, type UploadItem } from './remote-transfers';

/** 一台假机器:一棵内存里的目录树,读 / 写 / 建与那台机器上同一个约定。 */
function fakeMachine(files: Record<string, string> = {}, dirs: string[] = ['/w']) {
  const store = new Map(Object.entries(files).map(([p, text]) => [p, Buffer.from(text)]));
  const folders = new Set(dirs);
  const writes: SessionpageWorkspaceWriteRequest[] = [];
  const parts = new Map<string, Buffer[]>();
  const entries = (dir: string): SessionpageWorkspaceEntry[] => {
    const out: SessionpageWorkspaceEntry[] = [];
    for (const folder of folders) {
      if (folder !== dir && folder.slice(0, folder.lastIndexOf('/')) === dir) out.push({ name: folder.split('/').pop()!, path: folder, kind: 'dir', isDirectory: true, size: 0 });
    }
    for (const [p, bytes] of store) {
      if (p.slice(0, p.lastIndexOf('/')) === dir) out.push({ name: p.split('/').pop()!, path: p, kind: 'file', isDirectory: false, size: bytes.length });
    }
    return out;
  };
  const rpc = {
    listWorkspace: vi.fn(async (_d: string, request: { path?: string }) => ({ root: '/w', path: request.path ?? '/w', entries: entries(request.path ?? '/w'), truncated: false })),
    readWorkspaceFile: vi.fn(async (_d: string, request: { path: string; offset: number; length: number }) => {
      const bytes = store.get(request.path)!;
      return { path: request.path, size: bytes.length, etag: 'e1', offset: request.offset, data: bytes.subarray(request.offset, request.offset + request.length).toString('base64') };
    }),
    writeWorkspaceFile: vi.fn(async (_d: string, request: SessionpageWorkspaceWriteRequest) => {
      writes.push(request);
      const list = parts.get(request.uploadId) ?? [];
      list.push(Buffer.from(request.data, 'base64'));
      parts.set(request.uploadId, list);
      if (request.final) store.set(request.path, Buffer.concat(list));
      return { received: 0 };
    }),
    createWorkspaceEntry: vi.fn(async (_d: string, request: { dir: string; name: string; kind: 'file' | 'folder'; overwrite?: boolean }) => {
      const path = `${request.dir}/${request.name}`;
      if (request.kind === 'folder') folders.add(path);
      else if (!store.has(path)) store.set(path, Buffer.alloc(0));
      return { path };
    }),
  };
  return { rpc, store, folders, writes };
}

function fakeSink() {
  const written = new Map<string, Buffer>();
  const sink: DownloadSink & { finished: boolean[] } = {
    finished: [],
    begin: vi.fn(async (name: string) => ({ token: 't', target: `/Users/me/Downloads/${name}` })),
    write: vi.fn(async (_token: string, segments: string[], offset: number, data: string) => {
      const key = segments.join('/');
      const before = written.get(key) ?? Buffer.alloc(0);
      expect(offset).toBe(before.length);
      written.set(key, Buffer.concat([before, Buffer.from(data, 'base64')]));
    }),
    finish: vi.fn(async (_token: string, ok: boolean) => {
      sink.finished.push(ok);
      return ok ? '/Users/me/Downloads/x' : null;
    }),
  };
  return { sink, written };
}

const item = (segments: string[], text: string): UploadItem => {
  const bytes = Buffer.from(text);
  return { segments, size: bytes.length, slice: async (start, end) => new Uint8Array(bytes.subarray(start, end)) };
};

function transfers(machine: ReturnType<typeof fakeMachine>, options: { replace?: boolean; sink?: DownloadSink } = {}) {
  const confirmReplace = vi.fn(async () => options.replace ?? true);
  let n = 0;
  const t = new RemoteTransfers({
    rpc: () => machine.rpc as never,
    sessionId: 'c1',
    deviceId: 'dev',
    sink: options.sink ?? fakeSink().sink,
    confirmReplace,
    newId: () => `id-${(n += 1)}`,
    now: () => 0,
  });
  return { t, confirmReplace };
}

describe('上传到那台机器', () => {
  it('文件夹按层先建目录再传文件;字节分段、整份覆盖', async () => {
    const machine = fakeMachine();
    const { t, confirmReplace } = transfers(machine);
    const result = await t.upload('/w', [item(['site', 'css', 'a.css'], 'body{}'), item(['site', 'index.html'], '<h1>')], 'site');
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(result?.status).toBe('done');
    expect(result?.done).toBe(10);
    expect(machine.folders.has('/w/site/css')).toBe(true);
    expect(machine.store.get('/w/site/css/a.css')?.toString()).toBe('body{}');
    expect(machine.writes.every((w) => w.expectedEtag === WORKSPACE_WRITE_FORCE)).toBe(true);
    // 同一层目录只建一次。
    expect(machine.rpc.createWorkspaceEntry.mock.calls.filter(([, r]) => r.kind === 'folder' && r.name === 'site')).toHaveLength(1);
  });

  it('同名已有先问一次「替换」;人不替换就整次作罢', async () => {
    const machine = fakeMachine({ '/w/a.txt': 'old' });
    const { t, confirmReplace } = transfers(machine, { replace: false });
    expect(await t.upload('/w', [item(['a.txt'], 'new'), item(['b.txt'], 'b')], 'a.txt')).toBeNull();
    expect(confirmReplace).toHaveBeenCalledWith(['a.txt']);
    expect(machine.store.get('/w/a.txt')?.toString()).toBe('old');
    expect(machine.store.has('/w/b.txt')).toBe(false);
  });

  it('大于一段的文件按段传;超过单件上限的不传、如实列出来', async () => {
    const machine = fakeMachine();
    const { t } = transfers(machine);
    const big = 'x'.repeat(REMOTE_WORKSPACE_CHUNK_BYTES + 3);
    const huge: UploadItem = { segments: ['huge.iso'], size: REMOTE_WORKSPACE_MAX_FILE_BYTES + 1, slice: async () => new Uint8Array() };
    const result = await t.upload('/w', [item(['big.log'], big), huge], 'x');
    expect(machine.writes.map((w) => [w.offset, w.final])).toEqual([[0, false], [REMOTE_WORKSPACE_CHUNK_BYTES, true]]);
    expect(machine.store.get('/w/big.log')?.length).toBe(big.length);
    expect(result?.skipped).toEqual(['huge.iso']);
  });

  it('取消:停在下一段之前,状态 cancelled', async () => {
    const machine = fakeMachine();
    const { t } = transfers(machine);
    const slow: UploadItem = {
      segments: ['a.bin'],
      size: REMOTE_WORKSPACE_CHUNK_BYTES * 3,
      slice: async (start, end) => {
        t.items[0]!.cancel();
        return new Uint8Array(end - start);
      },
    };
    const result = await t.upload('/w', [slow], 'a.bin');
    expect(result?.status).toBe('cancelled');
    expect(machine.writes).toHaveLength(1);
  });
});

describe('下载到这台电脑', () => {
  it('单个文件:一段段读、一段段落盘,完了交回落点', async () => {
    const machine = fakeMachine({ '/w/report.md': '# hi' });
    const { sink, written } = fakeSink();
    const { t } = transfers(machine, { sink });
    const result = await t.download({ name: 'report.md', path: '/w/report.md', isDirectory: false, size: 4 });
    expect(result).toMatchObject({ status: 'done', done: 4, total: 4, target: '/Users/me/Downloads/x' });
    expect(written.get('')?.toString()).toBe('# hi');
    expect(sink.finished).toEqual([true]);
  });

  it('文件夹:先列一遍算总量,按层落;符号链接不跟', async () => {
    const machine = fakeMachine({ '/w/site/index.html': '<h1>', '/w/site/css/a.css': 'b{}' }, ['/w', '/w/site', '/w/site/css']);
    const { sink, written } = fakeSink();
    const { t } = transfers(machine, { sink });
    const result = await t.download({ name: 'site', path: '/w/site', isDirectory: true, size: 0 });
    expect(result).toMatchObject({ status: 'done', total: 7 });
    expect(written.get('index.html')?.toString()).toBe('<h1>');
    expect(written.get('css/a.css')?.toString()).toBe('b{}');
  });

  it('人在「放哪」取消 = 什么都不做;中途失败 = 落盘那一侧删掉半截', async () => {
    const machine = fakeMachine({ '/w/a': 'x' });
    const { sink } = fakeSink();
    (sink.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { t } = transfers(machine, { sink });
    expect(await t.download({ name: 'a', path: '/w/a', isDirectory: false, size: 1 })).toBeNull();
    machine.rpc.readWorkspaceFile.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'permission_denied' }));
    const failed = await t.download({ name: 'a', path: '/w/a', isDirectory: false, size: 1 });
    expect(failed?.status).toBe('failed');
    expect(sink.finished).toEqual([false]);
  });
});
