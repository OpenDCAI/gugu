import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInProcessTokenScanWorker } from './_support/in-process-worker';
import type { CachedLogFileRow, CachedLogFileSave } from './token-scan';
import { createTokenScanClient, type TokenCachePager, type TokenScanWorkerLike } from './token-scan-client';
import { createTokenScanService } from './token-scan-worker/service';

// #6334 用量页 token 扫描的主进程这一半:线程生命周期、库缓存分页灌入与逐条落库、一次只跑一轮;
// 以及验收线本身 —— 扫描期间 electron 主线程上没有任何一块超过 100 ms。

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gugu-usage-client-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function assistant(id: string, text = 'hi'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-23T10:00:00.000Z',
    requestId: `r-${id}`,
    message: {
      id,
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    },
  });
}

function memoryPager(initial: CachedLogFileRow[] = []): TokenCachePager & { rows: Map<string, CachedLogFileSave | CachedLogFileRow>; pages: number } {
  const rows = new Map<string, CachedLogFileSave | CachedLogFileRow>(initial.map((row) => [row.path, row]));
  const pager = {
    rows,
    pages: 0,
    loadPage(afterPath: string, limit: number) {
      pager.pages += 1;
      return [...rows.values()]
        .filter((row) => row.path > afterPath)
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .slice(0, limit)
        .map(({ path, size, mtimeMs, data }) => ({ path, size, mtimeMs, data }));
    },
    save(row: CachedLogFileSave) {
      rows.set(row.path, row);
    },
  };
  return pager;
}

function claudeHome(sessions: Record<string, string[]>): string {
  const root = join(dir, '.claude');
  const projectDir = join(root, 'projects', '-repo');
  mkdirSync(projectDir, { recursive: true });
  for (const [sid, lines] of Object.entries(sessions)) writeFileSync(join(projectDir, `${sid}.jsonl`), `${lines.join('\n')}\n`);
  return root;
}

describe('token-scan-client(进程内 worker)', () => {
  it('新解析的文件逐条落库;线程被收之后重起,从库缓存分页灌回,不重读文件', async () => {
    const root = claudeHome({ s1: [assistant('m1')], s2: [assistant('m2'), assistant('m2')] });
    const cache = memoryPager();
    let spawned = 0;
    const client = createTokenScanClient({
      spawn: () => {
        spawned += 1;
        return createInProcessTokenScanWorker();
      },
      cache,
    });
    const request = {
      providerSessions: [
        { provider: 'claude', providerSessionId: 's1' },
        { provider: 'claude', providerSessionId: 's2' },
      ],
      rootsByProvider: { claude: [root] },
      sourcesByProviderSession: {},
    };

    const first = await client.scan(request);
    expect(first.stats).toMatchObject({ files: 2, fullParses: 2 });
    // s2 里同一条消息写了两行,折叠后只算一次:两条会话合计 2 条请求。
    expect(first.rows).toEqual([
      { provider: 'claude', day: expect.any(String), model: 'claude-opus-5-5', source: null, input: 2, output: 4, cacheRead: 6, cacheWrite: 8 },
    ]);
    // 落库的消息是在 result 之前发的,到这里已经写完。
    expect(cache.rows.size).toBe(2);

    await client.dispose();
    const second = await client.scan(request);
    expect(spawned).toBe(2);
    expect(second.stats).toMatchObject({ cacheHits: 2, fullParses: 0, bytesRead: 0 });
    expect(second.rows).toEqual(first.rows);
    await client.dispose();
  });

  it('库缓存按页灌,不是一口气整张 SELECT', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ path: `/p/${String(i).padStart(3, '0')}`, size: 1, mtimeMs: 1, data: 'x' }));
    const cache = memoryPager(rows);
    const worker = createInProcessTokenScanWorker();
    const client = createTokenScanClient({ spawn: () => worker, cache });
    await client.scan({ providerSessions: [], rootsByProvider: {}, sourcesByProviderSession: {} });
    const hydrates = worker.received.filter((m) => m.type === 'hydrate');
    expect(hydrates.length).toBeGreaterThan(1);
    expect(hydrates.flatMap((m) => (m.type === 'hydrate' ? m.rows.map((r) => r.path) : []))).toEqual(rows.map((r) => r.path));
    // 全部 hydrate 在 scan 之前。
    expect(worker.received.at(-1)?.type).toBe('scan');
    await client.dispose();
  });

  it('并发的调用共用同一轮;线程崩了,在途请求判失败,下一次调用重起一个', async () => {
    const workers: ReturnType<typeof createInProcessTokenScanWorker>[] = [];
    const client = createTokenScanClient({
      spawn: () => {
        const worker = createInProcessTokenScanWorker();
        workers.push(worker);
        return worker;
      },
      cache: memoryPager(),
    });
    const request = { providerSessions: [], rootsByProvider: {}, sourcesByProviderSession: {} };
    const a = client.scan(request);
    const b = client.scan(request);
    expect(a).toBe(b);
    await a;

    const pending = client.scan(request);
    workers[0].crash(new Error('boom'));
    await expect(pending).rejects.toThrow(/boom/);

    await expect(client.scan(request)).resolves.toMatchObject({ rows: [] });
    expect(workers).toHaveLength(2);
    await client.dispose();
  });

  it('空闲到点收掉线程', async () => {
    const worker = createInProcessTokenScanWorker();
    const client = createTokenScanClient({ spawn: () => worker, cache: memoryPager(), idleMs: 20 });
    await client.scan({ providerSessions: [], rootsByProvider: {}, sourcesByProviderSession: {} });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(worker.terminated).toBe(true);
  });
});

/**
 * 验收线:扫描期间主线程上没有任何一块超过 100 ms(用户界面不许因为它冻住)。
 *
 * 判据:扫描进行时,主线程上每 5 ms 排一次的定时器,相邻两次触发之间**主线程自己花掉的 CPU 时间**的最大值。
 * 冻住界面的是主线程上的一整块同步工作,它花多久就记多少 CPU;墙钟间隔还含着线程排不上 CPU 的时间,
 * 那由机器负载决定,不由被测代码决定 —— 所以量本线程 CPU,不量墙钟。
 * 靶子:一行 64 MB 的 assistant 记录(真实日志里单行工具结果能到几十 MB)—— 它要被读、拼、解码、JSON.parse。
 * 阳控:同一个靶子、同一个判据,但把 worker 那一半跑在主线程上 —— 必须超线,否则这个判据判不出红。
 */
describe('验收线:扫描不冻主线程', () => {
  // 一行约 60 MB、三百万个小对象的 assistant 记录(真实日志里单行工具结果能到几十 MB)。
  // 用小对象而不是一根长字符串:JSON.parse 要逐个建对象,这一块在主线程上必然远超 100 ms —— 阳控才稳。
  function writeHugeSession(): string {
    const blocks = JSON.stringify(Array.from({ length: 3_000_000 }, () => ({ type: 'text', text: 'x' })));
    const huge = assistant('huge').replace('[{"type":"text","text":"hi"}]', blocks);
    return claudeHome({ big: [assistant('small'), huge, assistant('tail')] });
  }

  // 只计本线程:worker 线程的 CPU 不在里面。运行时是 .node-version 的 node 24;@types/node 仍是 20.x,没有这条声明。
  const threadCpuUsage = (process as NodeJS.Process & { threadCpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage })
    .threadCpuUsage.bind(process);

  async function maxMainThreadBlockMs(work: () => Promise<unknown>): Promise<number> {
    let last = threadCpuUsage();
    let maxBlockMs = 0;
    const timer = setInterval(() => {
      const spent = threadCpuUsage(last);
      maxBlockMs = Math.max(maxBlockMs, (spent.user + spent.system) / 1000);
      last = threadCpuUsage();
    }, 5);
    try {
      await work();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      clearInterval(timer);
    }
    return maxBlockMs;
  }

  const request = (root: string) => ({ providerSessions: [{ provider: 'claude', providerSessionId: 'big' }], rootsByProvider: { claude: [root] }, sourcesByProviderSession: {} });

  it('阳控:同样的活放在主线程上,判据会红(> 100 ms)', async () => {
    const root = writeHugeSession();
    const service = createTokenScanService(() => {});
    const block = await maxMainThreadBlockMs(() => service.handle({ type: 'scan', id: 1, ...request(root) }));
    expect(block).toBeGreaterThan(100);
  });

  it('真 worker 线程:同一个靶子,主线程最长一块 < 100 ms,结果正确', async () => {
    const root = writeHugeSession();
    // 与产品同形:把 worker 入口打成一个独立文件再起线程(产品里是 vite 的 lib 构建入口 usage-token-scan.js)。
    const bundle = join(dir, 'usage-token-scan.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./token-scan-worker/entry.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const client = createTokenScanClient({
      spawn: () => new Worker(bundle) as unknown as TokenScanWorkerLike,
      cache: memoryPager(),
    });
    let result: Awaited<ReturnType<typeof client.scan>> | undefined;
    const block = await maxMainThreadBlockMs(async () => {
      result = await client.scan(request(root));
    });
    await client.dispose();
    expect(result?.rows[0]).toMatchObject({ input: 3, output: 6 });
    expect(block).toBeLessThan(100);
  });
});
