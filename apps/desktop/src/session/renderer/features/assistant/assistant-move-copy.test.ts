import { describe, expect, it } from 'vitest';
import {
  COPY_CHUNK_BYTES,
  COPY_MAX_FILE_BYTES,
  COPY_MAX_TOTAL_BYTES,
  MoveCopyError,
  assertPlanFits,
  assertTotalFits,
  copyTree,
  copyUserInstructions,
  diffPlan,
  ensureDirChain,
  planTree,
  probeReadable,
  type FsEntry,
  type HomeFs,
} from './assistant-move-copy';

type Node = { kind: 'dir' } | { kind: 'file'; bytes: Uint8Array } | { kind: 'symlink' };

/** 一块内存盘:路径 → 节点。`writes` 记下每一块的落盘次序,`reads` 记读过哪些路径(核「旧家只读」)。 */
function memoryDisk(initial: Record<string, string | Uint8Array | 'dir' | 'symlink'> = {}) {
  const nodes = new Map<string, Node>();
  const writes: { path: string; offset: number; length: number }[] = [];
  const reads: string[] = [];
  const mutations: string[] = [];
  const pending = new Map<string, Uint8Array[]>();
  const put = (path: string, value: string | Uint8Array | 'dir' | 'symlink') => {
    if (value === 'dir') nodes.set(path, { kind: 'dir' });
    else if (value === 'symlink') nodes.set(path, { kind: 'symlink' });
    else nodes.set(path, { kind: 'file', bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value });
  };
  for (const [path, value] of Object.entries(initial)) put(path, value);

  const fs: HomeFs = {
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const out: FsEntry[] = [];
      for (const [path, node] of nodes) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest || rest.includes('/')) continue;
        out.push({
          name: rest,
          type: node.kind === 'dir' ? 'directory' : node.kind === 'file' ? 'file' : 'symlink',
          size: node.kind === 'file' ? node.bytes.length : 0,
        });
      }
      return out;
    },
    async readChunk(path, offset, length) {
      reads.push(path);
      const node = nodes.get(path);
      if (node?.kind !== 'file') throw new Error(`no file ${path}`);
      return node.bytes.slice(offset, offset + length);
    },
    async writeChunk({ path, uploadId, offset, data, total, final }) {
      mutations.push(path);
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (!nodes.has(parent)) throw new Error(`parent missing for ${path}`);
      const received = pending.get(uploadId) ?? [];
      const have = received.reduce((n, chunk) => n + chunk.length, 0);
      if (offset !== have) throw new Error(`out of order at ${offset}`);
      received.push(data);
      pending.set(uploadId, received);
      writes.push({ path, offset, length: data.length });
      if (!final) return null;
      const all = new Uint8Array(received.reduce((n, chunk) => n + chunk.length, 0));
      let at = 0;
      for (const chunk of received) {
        all.set(chunk, at);
        at += chunk.length;
      }
      pending.delete(uploadId);
      if (all.length !== total) throw new Error('size mismatch');
      nodes.set(path, { kind: 'file', bytes: all });
      return { size: all.length };
    },
    async makeDir(parent, name) {
      const path = `${parent}/${name}`;
      mutations.push(path);
      if (!nodes.has(parent)) throw new Error(`parent missing: ${parent}`);
      if (!nodes.has(path)) nodes.set(path, { kind: 'dir' });
    },
    async readText(path) {
      reads.push(path);
      const node = nodes.get(path);
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null;
    },
    async writeText(path, content) {
      mutations.push(path);
      nodes.set(path, { kind: 'file', bytes: new TextEncoder().encode(content) });
    },
  };
  const text = (path: string) => {
    const node = nodes.get(path);
    return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null;
  };
  return { fs, nodes, writes, reads, mutations, text };
}

describe('助理搬家拷文件 (#7199)', () => {
  it('记忆夹整棵树原样拷过去:嵌套目录、二进制、空文件;旧家一个字节都不写', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    const pending = JSON.stringify({ version: 1, items: [{ id: 'unfinished-work', source_link: 'original-source', state: 'waiting' }] });
    const old = memoryDisk({
      '/old/memory': 'dir',
      '/old/memory/MEMORY.md': '- [关于主人](owner-profile.md)\n',
      '/old/memory/owner-profile.md': '主人叫小满',
      '/old/memory/pending-work.json': pending,
      '/old/memory/refs': 'dir',
      '/old/memory/refs/pic.png': png,
      '/old/memory/refs/empty.txt': '',
    });
    const fresh = memoryDisk({ '/new': 'dir' });

    const plan = await planTree(old.fs, '/old/memory');
    expect(plan.dirs).toEqual(['refs']);
    expect(plan.files.map((f) => f.rel).sort()).toEqual(['MEMORY.md', 'owner-profile.md', 'pending-work.json', 'refs/empty.txt', 'refs/pic.png']);

    const copied = await copyTree({ from: old.fs, fromRoot: '/old/memory', to: fresh.fs, toBase: '/new', toRoot: '/new/.claude/projects/x/memory', plan });

    expect(copied).toBe(5);
    expect(fresh.text('/new/.claude/projects/x/memory/owner-profile.md')).toBe('主人叫小满');
    expect(fresh.text('/new/.claude/projects/x/memory/pending-work.json')).toBe(pending);
    expect(fresh.text('/new/.claude/projects/x/memory/refs/empty.txt')).toBe('');
    const copiedPng = fresh.nodes.get('/new/.claude/projects/x/memory/refs/pic.png');
    expect(copiedPng?.kind === 'file' && Array.from(copiedPng.bytes)).toEqual(Array.from(png));
    expect(old.mutations).toEqual([]);
  });

  it('大文件分块写,块序递增,总字节对得上', async () => {
    const big = new Uint8Array(COPY_CHUNK_BYTES * 2 + 123).map((_, i) => i % 251);
    const old = memoryDisk({ '/o': 'dir', '/o/big.bin': big });
    const fresh = memoryDisk({ '/n': 'dir', '/n/r': 'dir' });
    const plan = await planTree(old.fs, '/o');
    await copyTree({ from: old.fs, fromRoot: '/o', to: fresh.fs, toBase: '/n', toRoot: '/n/r', plan });

    expect(fresh.writes.map((w) => w.length)).toEqual([COPY_CHUNK_BYTES, COPY_CHUNK_BYTES, 123]);
    const node = fresh.nodes.get('/n/r/big.bin');
    expect(node?.kind === 'file' && node.bytes.length).toBe(big.length);
    expect(node?.kind === 'file' && node.bytes[COPY_CHUNK_BYTES + 5]).toBe((COPY_CHUNK_BYTES + 5) % 251);
  });

  it('软链接不跟、逐条回报;超过单文件上限 = 搬之前就失败', async () => {
    const old = memoryDisk({ '/o': 'dir', '/o/a.md': 'a', '/o/link': 'symlink' });
    const plan = await planTree(old.fs, '/o');
    expect(plan.skipped).toEqual([{ rel: 'link', reason: 'symlink' }]);
    expect(() => assertPlanFits(plan, '记忆')).not.toThrow();

    const tooBig = { dirs: [], files: [], skipped: [{ rel: 'video.mov', reason: 'file-too-large' as const }], totalBytes: 0 };
    expect(() => assertPlanFits(tooBig, '资料')).toThrow(MoveCopyError);
    expect(() => assertPlanFits(tooBig, '资料')).toThrow(`${COPY_MAX_FILE_BYTES / 1024 / 1024}MB`);
  });

  it('整批总量越界 = too_large;刚好等于上限放行', () => {
    const at = { dirs: [], files: [], skipped: [], totalBytes: COPY_MAX_TOTAL_BYTES };
    expect(() => assertPlanFits(at, '资料')).not.toThrow();
    expect(() => assertPlanFits({ ...at, totalBytes: COPY_MAX_TOTAL_BYTES + 1 }, '资料')).toThrowError(
      expect.objectContaining({ code: 'too_large' })
    );
  });

  it('写完核大小:对面落盘的字节数不对 = copy_mismatch,不当成功', async () => {
    const old = memoryDisk({ '/o': 'dir', '/o/a.md': 'hello' });
    const lying = memoryDisk({ '/n': 'dir', '/n/r': 'dir' });
    const real = lying.fs.writeChunk;
    lying.fs.writeChunk = async (args) => {
      const result = await real(args);
      return result ? { size: result.size - 1 } : result;
    };
    const plan = await planTree(old.fs, '/o');
    await expect(copyTree({ from: old.fs, fromRoot: '/o', to: lying.fs, toBase: '/n', toRoot: '/n/r', plan })).rejects.toMatchObject({
      code: 'copy_mismatch',
    });
  });

  it('读的时候文件被改短了:提前读空 = copy_mismatch,不留半个文件当成功', async () => {
    const old = memoryDisk({ '/o': 'dir', '/o/a.md': 'hello world' });
    const plan = await planTree(old.fs, '/o');
    const truncating: HomeFs = { ...old.fs, readChunk: async () => new Uint8Array(0) };
    const fresh = memoryDisk({ '/n': 'dir', '/n/r': 'dir' });
    await expect(copyTree({ from: truncating, fromRoot: '/o', to: fresh.fs, toBase: '/n', toRoot: '/n/r', plan })).rejects.toMatchObject({
      code: 'copy_mismatch',
    });
  });

  it('重来安全:同一批拷两遍,结果与拷一遍相同(同路径覆盖)', async () => {
    const old = memoryDisk({ '/o': 'dir', '/o/a.md': 'v1', '/o/d': 'dir', '/o/d/b.md': 'v2' });
    const fresh = memoryDisk({ '/n': 'dir' });
    const plan = await planTree(old.fs, '/o');
    const args = { from: old.fs, fromRoot: '/o', to: fresh.fs, toBase: '/n', toRoot: '/n/r', plan };
    await copyTree(args);
    await copyTree(args);
    expect(fresh.text('/n/r/a.md')).toBe('v1');
    expect(fresh.text('/n/r/d/b.md')).toBe('v2');
  });

  it('只写不删:新家里原来就有、旧家没有的文件原样留着', async () => {
    const old = memoryDisk({ '/o': 'dir', '/o/a.md': 'a' });
    const fresh = memoryDisk({ '/n': 'dir', '/n/r': 'dir', '/n/r/only-here.md': '新家自己的' });
    const plan = await planTree(old.fs, '/o');
    await copyTree({ from: old.fs, fromRoot: '/o', to: fresh.fs, toBase: '/n', toRoot: '/n/r', plan });
    expect(fresh.text('/n/r/only-here.md')).toBe('新家自己的');
  });

  it('ensureDirChain:目标不在 base 之下 = 抛(不往错地方建)', async () => {
    const disk = memoryDisk({ '/n': 'dir' });
    await expect(ensureDirChain(disk.fs, '/n', '/elsewhere/x')).rejects.toThrow('not inside');
  });
});

describe('说明只搬人写的那一段', () => {
  const OLD_MANAGED = '<!-- 咕咕管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->\n旧家的管家段\n<!-- /咕咕管家 -->';
  const NEW_MANAGED = '<!-- 咕咕管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->\n新家的管家段\n<!-- /咕咕管家 -->';

  it('新家的管家段原样留着,人写的换成旧家的(❌ 旧家的管家段盖过去)', async () => {
    const old = memoryDisk({ '/o/CLAUDE.md': `${OLD_MANAGED}\n\n叫我小满,说话简短。\n` });
    const fresh = memoryDisk({ '/n/CLAUDE.md': `${NEW_MANAGED}\n` });

    const wrote = await copyUserInstructions({ from: old.fs, fromPath: '/o/CLAUDE.md', to: fresh.fs, toPath: '/n/CLAUDE.md' });

    expect(wrote).toBe(true);
    const text = fresh.text('/n/CLAUDE.md') ?? '';
    expect(text).toContain('新家的管家段');
    expect(text).not.toContain('旧家的管家段');
    expect(text).toContain('叫我小满,说话简短。');
  });

  it('旧家没有说明 / 人没写过 = 不动新家那份', async () => {
    const none = memoryDisk({});
    const onlyManaged = memoryDisk({ '/o/CLAUDE.md': OLD_MANAGED });
    const fresh = memoryDisk({ '/n/CLAUDE.md': `${NEW_MANAGED}\n` });
    expect(await copyUserInstructions({ from: none.fs, fromPath: '/o/CLAUDE.md', to: fresh.fs, toPath: '/n/CLAUDE.md' })).toBe(false);
    expect(await copyUserInstructions({ from: onlyManaged.fs, fromPath: '/o/CLAUDE.md', to: fresh.fs, toPath: '/n/CLAUDE.md' })).toBe(false);
    expect(fresh.mutations).toEqual([]);
  });
});

describe('搬之前试读 / 补拷的差集 / 总量', () => {
  it('probeReadable:读不了的文件(目录列表当普通文件报出来的坏链接)第一个就抛,带相对路径', async () => {
    const d = memoryDisk({ '/o/a.md': '一', '/o/bad.md': '二' });
    const realRead = d.fs.readChunk;
    d.fs.readChunk = async (path, offset, length) => {
      if (path.endsWith('bad.md')) throw new Error('outside workspace');
      return realRead(path, offset, length);
    };
    const plan = await planTree(d.fs, '/o');
    await expect(probeReadable(d.fs, '/o', plan)).rejects.toMatchObject({ code: 'unreadable', message: expect.stringContaining('bad.md') });
  });

  it('probeReadable:都读得了 = 过;0 字节的文件不读', async () => {
    const d = memoryDisk({ '/o/a.md': '一', '/o/empty.md': '' });
    const plan = await planTree(d.fs, '/o');
    await expect(probeReadable(d.fs, '/o', plan)).resolves.toBeUndefined();
    expect(d.reads).not.toContain('/o/empty.md');
  });

  it('diffPlan:新出现的、大小变了的、修改时刻变了的才补;没变的不重拷', () => {
    const base = { dirs: [], skipped: [], totalBytes: 0 };
    const previous = { ...base, files: [{ rel: 'same.md', size: 1, mtime: 10 }, { rel: 'grown.md', size: 1, mtime: 10 }, { rel: 'touched.md', size: 1, mtime: 10 }] };
    const next = {
      ...base,
      files: [
        { rel: 'same.md', size: 1, mtime: 10 },
        { rel: 'grown.md', size: 5, mtime: 10 },
        { rel: 'touched.md', size: 1, mtime: 99 },
        { rel: 'new.md', size: 2, mtime: 50 },
      ],
    };
    const delta = diffPlan(previous, next);
    expect(delta.files.map((f) => f.rel)).toEqual(['grown.md', 'touched.md', 'new.md']);
    expect(delta.totalBytes).toBe(8);
  });

  it('assertTotalFits:几棵树加起来越界就抛', () => {
    expect(() => assertTotalFits(COPY_MAX_TOTAL_BYTES)).not.toThrow();
    expect(() => assertTotalFits(COPY_MAX_TOTAL_BYTES + 1)).toThrow(MoveCopyError);
  });
});
