import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliLoginOutcome, CliLoginRun } from './cli/cli-login';
import type { CliLoginPrompt } from './cli/cli-tools';
import { installedCliTool } from './cli/cli-tool-installer';

/**
 * 官方命令行的连接:同一家先后点了几次「连接」、中途关了弹窗,每一次只收拾自己起的登录(审查 #7237 实撞的三种)。
 * 装工具与起进程换成可控的假的,其余(登记、核号、工作目录、记录与启动器的先后)都是真的。
 *
 * 这里每一步都等**那件事发生**再往下走(登录进程被起起来了、一次连接落地了),❌ 等一段时间赌它已经发生:
 * 起进程之前服务要在磁盘上建三个目录,机器一忙(CI 的 mac1)二十毫秒不够,读到的就是「还没起」。
 */

type FakeRun = {
  run: CliLoginRun;
  showPrompt: (prompt: CliLoginPrompt) => void;
  exit: (outcome: CliLoginOutcome) => void;
  /** 像进程被杀掉那样立刻结束:授权提示落空、进程退出。已经结束的再叫一次没有作用。 */
  stop: () => void;
  cancelled: boolean;
};

const fake = vi.hoisted(() => ({
  install: null as null | { promise: Promise<unknown>; resolve: (value: unknown) => void },
  runs: [] as FakeRun[],
  /** 等第 n 个登录进程被起起来的人。 */
  runWaiters: [] as Array<{ index: number; resolve: (run: FakeRun) => void }>,
  /** 服务挂在登录进程「结束」上的后续(删这一次的工作目录):收尾时等它们落地,再删 GUGU_HOME。 */
  afterExit: [] as Promise<unknown>[],
  records: new Map<string, unknown>(),
  loggedIn: true,
  verification: null as Promise<boolean> | null,
  verifyStarted: false,
  publishFails: false,
  storeFails: false,
  launchers: new Set<string>(),
}));

vi.mock('./cli/cli-tool-installer', async (importActual) => {
  const actual = await importActual<typeof import('./cli/cli-tool-installer')>();
  return {
    ...actual,
    ensureCliTool: (tool: 'dws' | 'wecom-cli' | 'lark-cli') => {
      const installed = actual.installedCliTool(tool);
      return fake.install ? fake.install.promise.then(() => installed) : Promise.resolve(installed);
    },
  };
});

vi.mock('./cli/cli-login', async (importActual) => {
  const actual = await importActual<typeof import('./cli/cli-login')>();

  /** 「结束」这个 promise 上挂的每一个后续都记下来;派生出来的是普通 promise,不再记。 */
  class TrackedExit<T> extends Promise<T> {
    static override get [Symbol.species]() {
      return Promise;
    }
    override then<A = T, B = never>(
      onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
      const next = super.then(onFulfilled, onRejected);
      fake.afterExit.push(next);
      return next;
    }
  }

  return {
    ...actual,
    readCliLoginStatus: async () => fake.loggedIn,
    startCliLogin: (): CliLoginRun => {
      let showPrompt!: (prompt: CliLoginPrompt) => void;
      let failPrompt!: (error: Error) => void;
      let exit!: (outcome: CliLoginOutcome) => void;
      const prompt = new Promise<CliLoginPrompt>((resolve, reject) => ((showPrompt = resolve), (failPrompt = reject)));
      prompt.catch(() => {});
      const done = new TrackedExit<CliLoginOutcome>((resolve) => (exit = resolve));
      const stop = () => {
        failPrompt(new Error('stopped'));
        exit({ kind: 'cancelled', output: '' });
      };
      const entry: FakeRun = {
        run: {
          prompt,
          done,
          // 真进程收到 SIGTERM 到退出要一会儿:那一下之后,旧的一次的失败才落地。
          cancel: () => {
            entry.cancelled = true;
            setTimeout(stop, 50);
          },
        },
        showPrompt,
        exit,
        stop,
        cancelled: false,
      };
      fake.runs.push(entry);
      const index = fake.runs.length - 1;
      fake.runWaiters = fake.runWaiters.filter((waiter) => (waiter.index === index ? (waiter.resolve(entry), false) : true));
      return entry.run;
    },
  };
});

vi.mock('./cli/feishu-login', async (importActual) => ({
  ...await importActual<typeof import('./cli/feishu-login')>(),
  verifyFeishuLogin: async () => { fake.verifyStarted = true; return fake.verification ?? true; },
  setFeishuUserIdentity: async () => undefined,
}));

vi.mock('./cli/cli-integrations', async (importActual) => {
  const actual = await importActual<typeof import('./cli/cli-integrations')>();
  return {
    ...actual,
    publishCliLauncher: async (recipe: { bin: string }) => {
      if (fake.publishFails) throw new Error('disk full');
      fake.launchers.add(recipe.bin);
    },
    removeCliLauncher: async (recipe: { bin: string }) => void fake.launchers.delete(recipe.bin),
  };
});

vi.mock('./integration-credential-store-instance', () => ({
  integrationCredentialStore: {
    isConfigured: async (id: string) => fake.records.has(id),
    getAccount: async (id: string) => (fake.records.has(id) ? { accountId: 'default', credentials: fake.records.get(id) } : null),
    upsertAccount: async (id: string, account: { credentials: unknown }) => {
      if (fake.storeFails) throw new Error('secure storage unavailable');
      fake.records.set(id, account.credentials);
    },
    delete: async (id: string) => void fake.records.delete(id),
  },
}));

const { IntegrationConnectionService } = await import('./integration-connection-service');
type Service = InstanceType<typeof IntegrationConnectionService>;

const DEVICE: CliLoginPrompt = { kind: 'device-link', url: 'https://login.dingtalk.com/x?user_code=AAAA-BBBB', code: 'AAAA-BBBB' };
let guguHome: string;
const previousHome = process.env.GUGU_HOME;
/** 这个用例里点过的每一次「连接」:收尾时等它们都落地。 */
let starts: Promise<unknown>[] = [];

function holdInstall() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  fake.install = { promise, resolve };
  return () => resolve(undefined);
}

/** 点一次「连接」。 */
function start(service: Service): ReturnType<Service['cliLoginStart']> {
  const started = service.cliLoginStart('dingtalk');
  starts.push(started);
  return started;
}

/** 等第 `index` 个(从 0 数)登录进程被起起来。 */
function runAt(index: number): Promise<FakeRun> {
  const existing = fake.runs[index];
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => fake.runWaiters.push({ index, resolve }));
}

/** 登录用的工作目录(`integration-tools/dws/login-*`):每一次登录结束,服务都要删掉自己那一个。 */
function loginWorkDirs(): string[] {
  try {
    return readdirSync(path.join(guguHome, 'integration-tools', 'dws')).filter((name) => name.startsWith('login-'));
  } catch {
    return [];
  }
}

/** 改之前的实现在这几种情形里会让 `cliLoginStart` 永远不回:超时就是红,❌ 无限挂着。 */
const TIMEOUT = 5_000;

beforeEach(() => {
  guguHome = mkdtempSync(path.join(tmpdir(), 'gugu-cli-service-'));
  process.env.GUGU_HOME = guguHome;
  fake.install = null;
  fake.runs = [];
  fake.runWaiters = [];
  fake.afterExit = [];
  fake.records.clear();
  fake.launchers.clear();
  fake.loggedIn = true;
  fake.verification = null;
  fake.verifyStarted = false;
  fake.publishFails = false;
  fake.storeFails = false;
  starts = [];
});

afterEach(async () => {
  // 先让一切停下来,再删目录 —— 用例中途红了也一样(❌ 一边删、服务一边还在里面建目录 = ENOTEMPTY)。
  fake.install?.resolve(undefined);
  for (const entry of fake.runs) entry.stop();
  await Promise.allSettled(starts);
  // 落地的过程里还可能挂上新的后续:等到不再增加为止。
  for (let seen = -1; seen !== fake.afterExit.length; ) {
    seen = fake.afterExit.length;
    await Promise.allSettled(fake.afterExit);
  }
  const leftover = loginWorkDirs();

  if (previousHome === undefined) delete process.env.GUGU_HOME;
  else process.env.GUGU_HOME = previousHome;
  rmSync(guguHome, { recursive: true, force: true });
  expect(leftover, '每一次登录结束都删掉自己的工作目录').toEqual([]);
});

describe('cliLoginStart —— 一次连接只收拾自己', () => {
  it('装到一半关了弹窗:装完不再起登录(❌ 一个没人看的登录在后台等十五分钟)', async () => {
    const service = new IntegrationConnectionService();
    const finishInstall = holdInstall();
    const started = start(service); // 这一次的号在调用当下就登记了,装工具还卡着
    service.cancelAuthorization('dingtalk');
    finishInstall();
    await expect(started).resolves.toMatchObject({ success: false });
    expect(fake.runs).toHaveLength(0);
  }, TIMEOUT);

  it('关了又马上重开再点连接:只起一个登录,就是新的那一次的', async () => {
    const service = new IntegrationConnectionService();
    const finishInstall = holdInstall();
    const first = start(service);
    service.cancelAuthorization('dingtalk');
    const second = start(service);
    finishInstall();
    await expect(first).resolves.toMatchObject({ success: false });
    (await runAt(0)).showPrompt(DEVICE);
    await expect(second).resolves.toEqual({ success: true, prompt: DEVICE });
    // 两次都落地了,不会再有人起登录:只有新的那一次起的那一个,而且没被撤。
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.cancelled).toBe(false);
  }, TIMEOUT);

  it('旧的一次晚到的失败,不撤新的一次起的登录', async () => {
    const service = new IntegrationConnectionService();
    const first = start(service);
    const firstRun = await runAt(0);
    const second = start(service); // 取代第一次:第一次的登录被撤,它的 prompt 落空
    expect(firstRun.cancelled).toBe(true);
    await expect(first).resolves.toMatchObject({ success: false });
    const secondRun = await runAt(1);
    secondRun.showPrompt(DEVICE);
    await expect(second).resolves.toMatchObject({ success: true });
    expect(fake.runs).toHaveLength(2);
    expect(secondRun.cancelled).toBe(false);

    secondRun.exit({ kind: 'exited', code: 0, output: '' });
    await expect(service.cliLoginWait('dingtalk')).resolves.toEqual({ status: 'connected' });
    expect(fake.records.get('dingtalk')).toMatchObject({ tool: 'dws' });
    expect(fake.launchers.has('dws')).toBe(true);
  }, TIMEOUT);
});

describe('cliLoginWait —— 记录与命令同进同退', () => {
  async function startAndExit(service: Service) {
    const started = start(service);
    const run = await runAt(fake.runs.length);
    run.showPrompt(DEVICE);
    await started;
    run.exit({ kind: 'exited', code: 0, output: '' });
    return service.cliLoginWait('dingtalk');
  }

  it('命令放不上 PATH → 撤回记录,失败带原因(❌ 记着连着、agent 却敲不到)', async () => {
    fake.publishFails = true;
    await expect(startAndExit(new IntegrationConnectionService())).resolves.toEqual({ status: 'failed', error: 'disk full' });
    expect(fake.records.has('dingtalk')).toBe(false);
  }, TIMEOUT);

  it('记录存不进去 → 失败带原因,命令也不上 PATH', async () => {
    fake.storeFails = true;
    await expect(startAndExit(new IntegrationConnectionService())).resolves.toEqual({
      status: 'failed',
      error: 'secure storage unavailable',
    });
    expect(fake.launchers.size).toBe(0);
  }, TIMEOUT);

  it('登录进程正常退出,但工具说没登上 → 失败,什么都不记', async () => {
    fake.loggedIn = false;
    await expect(startAndExit(new IntegrationConnectionService())).resolves.toMatchObject({ status: 'failed' });
    expect(fake.records.has('dingtalk')).toBe(false);
    expect(fake.launchers.size).toBe(0);
  }, TIMEOUT);

  it('断开:命令和记录都没了', async () => {
    const service = new IntegrationConnectionService();
    await expect(startAndExit(service)).resolves.toEqual({ status: 'connected' });
    await expect(service.disconnect('dingtalk')).resolves.toEqual({ success: true });
    expect(fake.launchers.size).toBe(0);
    expect(fake.records.has('dingtalk')).toBe(false);
  }, TIMEOUT);
});


describe('飞书已验证的个人登录复用', () => {
  function configured() {
    const file = path.join(installedCliTool('lark-cli').homeDir, 'config', 'config.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{}');
  }

  it('已有个人授权经服务端核验后直接连接，不启动另一次登录', async () => {
    configured();
    const service = new IntegrationConnectionService();
    await expect(service.cliLoginStart('feishu')).resolves.toEqual({ success: true, connected: true });
    expect(fake.records.get('feishu')).toMatchObject({ tool: 'lark-cli' });
    expect(fake.launchers.has('lark-cli')).toBe(true);
    expect(fake.runs).toHaveLength(0);
  });

  it('复用路径的启动器发布失败也必须撤回连接记录', async () => {
    configured();
    fake.publishFails = true;
    await expect(new IntegrationConnectionService().cliLoginStart('feishu')).resolves.toEqual({ success: false, error: 'disk full' });
    expect(fake.records.has('feishu')).toBe(false);
    expect(fake.launchers.size).toBe(0);
  });

  it('服务端核验过程中取消，不保存连接或发布命令', async () => {
    configured();
    let resolve!: (verified: boolean) => void;
    fake.verification = new Promise<boolean>((r) => { resolve = r; });
    const service = new IntegrationConnectionService();
    const started = service.cliLoginStart('feishu');
    starts.push(started);
    await vi.waitFor(() => expect(fake.verifyStarted).toBe(true));
    service.cancelAuthorization('feishu');
    resolve(true);
    await expect(started).resolves.toMatchObject({ success: false });
    expect(fake.records.size).toBe(0);
    expect(fake.launchers.size).toBe(0);
  });
});
