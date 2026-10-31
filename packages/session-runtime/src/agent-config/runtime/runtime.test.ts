import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type {
  AgentAuthContext,
  AgentAuthStatus,
  CLIAgentPluginProvider,
  McpServerRegistration,
  PluginFs,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import { AgentPluginHost, createPluginRegistry } from '@gugu/session-core/agents/plugins';
import type { ExecContextOptions, IExecutionContext } from '@gugu/session-core/exec';
import type { McpServer } from '@gugu/session-core/mcp';
import type { PtyExitInfo, PtyProcess, PtySpawnSpec, PtySpawner } from '@gugu/session-core/pty';
import { ok } from '@gugu/session-shared';
import type { Logger } from '@gugu/session-shared/logger';
import { noopLogger } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { AgentConfigRuntime } from './runtime';
import { AuthExpiryMarks, type AuthExpiryPersistence } from './auth-expiry';

/**
 * 登录 / 登录状态跑哪一份 CLI 由宿主定(#5683)。故意与 PATH 上探得到的 `/opt/fake-agent` 不同:
 * 断言读到这条路径,才证明 worker 用的是宿主的答案、没有自己去找。
 */
/**
 * 宿主算好的运行上下文(#5702)。env 也在里面 —— worker 侧已经**没有** `deps.env` 了,
 * 这里的断言若能读到某个变量,就只可能是从这一格来的。
 */
const HOST_ENV = {
  PATH: '/bin',
  HOME: '/home/ada',
  USER: 'ada',
  SHELL: '/bin/zsh',
  ANTHROPIC_API_KEY: 'secret',
};
const SELECTED_CLI_PATH = '/opt/selected/claude2';
const SELECTED_CLI: AgentRunContext = {
  cli: { kind: 'resolved', path: '/opt/selected/claude2' },
  env: HOST_ENV,
  configRootEnv: {},
  selfUpdateEnv: {},
  extraArgs: [],
};
const OTHER_CLI: AgentRunContext = {
  cli: { kind: 'resolved', path: '/opt/other/claude' },
  env: HOST_ENV,
  configRootEnv: {},
  selfUpdateEnv: {},
  extraArgs: [],
};

class FakeExecutionContext implements IExecutionContext {
  readonly supportsLocalSpawn = true;
  readonly exec = vi.fn(
    async (command: string, args: string[] = [], _opts: ExecContextOptions = {}) => {
      if (command === 'which' && args[0] === 'fake-agent') {
        return { stdout: '/opt/fake-agent\n', stderr: '' };
      }
      if (command === 'which' && args[0] === '-a' && args[1] === 'fake-agent') {
        return { stdout: '/opt/fake-agent\n', stderr: '' };
      }
      if (command === 'realpath' && args[0]) {
        return { stdout: `${args[0]}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  );
  readonly execStreaming = vi.fn(
    async (
      _command: string,
      _args: string[],
      _onChunk: (chunk: string) => boolean,
      _opts: { signal?: AbortSignal } = {}
    ) => {}
  );
  readonly dispose = vi.fn();
}

class FakePtySpawner implements PtySpawner {
  readonly processes: FakePtyProcess[] = [];
  readonly spawn = vi.fn((spec: PtySpawnSpec): PtyProcess => {
    const process = new FakePtyProcess(spec);
    this.processes.push(process);
    return process;
  });
}

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  killed = false;
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(info: PtyExitInfo) => void> = [];

  constructor(readonly spec: PtySpawnSpec) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.spec.cols = cols;
    this.spec.rows = rows;
  }

  kill(): void {
    this.killed = true;
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  getPid(): number {
    return 123;
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(info: PtyExitInfo = { exitCode: 0, signal: null }): void {
    for (const handler of this.exitHandlers) handler(info);
  }
}

class MemoryPluginFs implements PluginFs {
  private readonly files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async delete(path: string): Promise<void> {
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const entries = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const entry = key.slice(prefix.length).split('/')[0];
      if (entry) entries.add(entry);
    }
    return [...entries].sort();
  }
}

/**
 * 登录态 / 鉴权读数都是同步可读的状态,而它们的发布(agents 列表)会跳过没变的快照 —— 「这次检查跑过了」
 * 不一定带出一条更新,所以这里用 `until` 读状态,不设期限。相等判定用 vitest 的 toEqual 语义。
 */
const deepEquals = (actual: unknown, expected: unknown): boolean => {
  try {
    expect(actual).toEqual(expected);
    return true;
  } catch {
    return false;
  }
};

describe('AgentConfigRuntime', () => {
  it('checks auth status against the host-resolved CLI with allowlisted env', async () => {
    const authCheckStatus = vi.fn(async (_ctx: AgentAuthContext) => ({
      kind: 'authenticated' as const,
    }));
    const { runtime } = makeRuntime({ authCheckStatus });

    const result = await runtime.refreshAuthStatus('claude', SELECTED_CLI);

    expect(result.success).toBe(true);
    expect(authCheckStatus).toHaveBeenCalledTimes(1);
    const ctx = authCheckStatus.mock.calls[0]?.[0];
    // PATH 上探得到的是 `/opt/fake-agent`;读到选中那份才证明 worker 没有自己去找。
    expect(ctx?.cli).toBe(SELECTED_CLI_PATH);
    expect(ctx?.env.ANTHROPIC_API_KEY).toBe('secret');
    // 宿主没给的变量,worker 里无处可取 —— `AgentHostDeps` 上已经没有 `env` 了(#5702)。
    expect(ctx?.env.UNSAFE_ENV).toBeUndefined();
    expect(ctx?.env.SHELL).toBe('/bin/zsh');
    await runtime.dispose();
  });

  it('reports an unresolved host CLI as an unknown status without probing', async () => {
    const authCheckStatus = vi.fn(async () => ({ kind: 'authenticated' as const }));
    const { runtime } = makeRuntime({ authCheckStatus });

    const result = await runtime.refreshAuthStatus('claude', {
      ...SELECTED_CLI,
      cli: { kind: 'unresolved', message: 'selected copy is gone' },
    });

    expect(result).toEqual(ok({ kind: 'unknown' }));
    expect(authCheckStatus).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('saves and lists MCP servers through provider behavior', async () => {
    const { runtime } = makeRuntime();
    const server: McpServer = {
      name: 'filesystem',
      transport: 'stdio',
      command: 'fs-mcp',
      args: ['/tmp'],
      providers: ['claude'],
    };

    const saved = await runtime.saveMcpServer(server);
    const listed = await runtime.listMcpForAgent('claude');

    expect(saved.success).toBe(true);
    expect(listed).toEqual(ok([server]));
    await runtime.dispose();
  });

  it('starts login on the host-resolved CLI through a managed PTY and exposes output', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner });

    const started = await runtime.startLogin('claude', 'login', SELECTED_CLI);

    expect(started).toEqual(ok(undefined));
    expect(ptySpawner.processes).toHaveLength(1);
    expect(ptySpawner.processes[0]?.spec).toMatchObject({
      command: SELECTED_CLI_PATH,
      args: [],
      cwd: '/home/ada',
      cols: 120,
      rows: 30,
    });

    ptySpawner.processes[0]?.emitData('Open https://example.com/login\n');
    expect((await runtime.loginOutputLog('claude')?.snapshot())?.data.text).toBe(
      'Open https://example.com/login\n'
    );

    expect(runtime.sendLoginInput('claude', 'code\n')).toEqual(ok(undefined));
    expect(ptySpawner.processes[0]?.writes).toEqual(['code\n']);
    await runtime.dispose();
  });

  it('#6264 a colored sign-in link is handed out without its terminal escape codes', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner, headlessArgs: ['login', '--device-auth'] });
    await runtime.startLogin('claude', 'login', SELECTED_CLI, undefined, { headless: true });
    // codex 0.156.1 `login --device-auth` 逐字节印的就是这样(走查机实测)。
    ptySpawner.processes[0]?.emitData(
      '1. Open this link in your browser\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n'
    );
    expect(runtime.install.getAuth('claude').login?.pendingUrl?.url).toBe(
      'https://auth.openai.com/codex/device'
    );
    await runtime.dispose();
  });

  it.each(['one chunk', 'separate chunks', 'split URL', 'one character at a time'])(
    'Codex login exposes the complete authorization URL after its callback listener (%s)',
    async (delivery) => {
      const ptySpawner = new FakePtySpawner();
      const { runtime } = makeRuntime({ ptySpawner });
      await runtime.startLogin('claude', 'login', SELECTED_CLI);
      const process = ptySpawner.processes[0]!;
      const listener = 'Starting local login server on http://localhost:1455.\r\n';
      const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=test-challenge&code_challenge_method=S256&state=test-state&scope=openid+profile+email+offline_access&originator=codex_cli_rs';
      const prompt = 'If your browser did not open, navigate to this URL to authenticate:\r\n\r\n';
      if (delivery === 'one chunk') {
        process.emitData(`${listener}${prompt}${url}\r\n`);
      } else {
        process.emitData(listener);
        expect(runtime.install.getAuth('claude').login?.pendingUrl).toBeNull();
        process.emitData(prompt);
        if (delivery === 'one character at a time') {
          for (const character of `\x1b[94m${url}\x1b[0m`) {
            process.emitData(character);
            expect(runtime.install.getAuth('claude').login?.pendingUrl).toBeNull();
          }
          process.emitData('\r\n');
        } else if (delivery === 'split URL') {
          process.emitData('\x1b[9');
          process.emitData(`4m${url.slice(0, 150)}`);
          expect(runtime.install.getAuth('claude').login?.pendingUrl).toBeNull();
          process.emitData(`${url.slice(150)}\x1b[0m\r\n`);
        } else {
          process.emitData(`${url}\r\n`);
        }
      }
      expect(runtime.install.getAuth('claude').login?.pendingUrl?.url).toBe(url);
      await runtime.dispose();
    }
  );

  it.each(['http://127.0.0.1:1455', 'http://[::1]:1455', 'http://localhost.:1455'])(
    'does not offer a local callback listener as an authorization link (%s)',
    async (listener) => {
      const ptySpawner = new FakePtySpawner();
      const { runtime } = makeRuntime({ ptySpawner });
      await runtime.startLogin('claude', 'login', SELECTED_CLI);
      ptySpawner.processes[0]!.emitData(`Listening on ${listener}.\nhttps://example.com/login\n`);
      expect(runtime.install.getAuth('claude').login?.pendingUrl?.url).toBe('https://example.com/login');
      await runtime.dispose();
    }
  );

  it('#6264 headless login runs the declared headlessArgs, and refuses a family without one', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner, headlessArgs: ['login', '--device-auth'] });
    expect(await runtime.startLogin('claude', 'login', SELECTED_CLI, undefined, { headless: true })).toEqual(ok(undefined));
    expect(ptySpawner.processes[0]?.spec).toMatchObject({
      command: SELECTED_CLI_PATH,
      args: ['login', '--device-auth'],
    });
    await runtime.dispose();

    // 没声明:❌ 退回会回跳 localhost 的那条 —— 直接拒,一个 PTY 都不起。
    const bare = new FakePtySpawner();
    const { runtime: plain } = makeRuntime({ ptySpawner: bare });
    const refused = await plain.startLogin('claude', 'login', SELECTED_CLI, undefined, { headless: true });
    expect(refused.success).toBe(false);
    expect(bare.processes).toHaveLength(0);
    await plain.dispose();
  });

  it('cancels login by releasing the managed PTY', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner });
    await runtime.startLogin('claude', 'login', SELECTED_CLI);

    await expect(runtime.cancelLogin('claude')).resolves.toEqual(ok(undefined));

    expect(ptySpawner.processes[0]?.killed).toBe(true);
    expect(runtime.loginOutputLog('claude')).toBeNull();
    expect(runtime.sendLoginInput('claude', 'code\n').success).toBe(false);
    await runtime.dispose();
  });

  it('restarts login for repeated starts on the same provider', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner });

    await runtime.startLogin('claude', 'login', SELECTED_CLI);
    await runtime.startLogin('claude', 'login', SELECTED_CLI);

    expect(ptySpawner.processes).toHaveLength(2);
    expect(ptySpawner.processes[0]?.killed).toBe(true);
    expect(ptySpawner.processes[1]?.killed).toBe(false);
    await runtime.dispose();
  });

  it('ignores stale output and exit callbacks from a replaced login', async () => {
    const ptySpawner = new FakePtySpawner();
    const authCheckStatus = vi.fn(async () => ({ kind: 'unauthenticated' as const }));
    const { runtime } = makeRuntime({ authCheckStatus, ptySpawner });

    await runtime.startLogin('claude', 'login', SELECTED_CLI);
    const first = ptySpawner.processes[0];
    await runtime.startLogin('claude', 'login', SELECTED_CLI);
    const second = ptySpawner.processes[1];

    first?.emitData('Open https://example.com/old\n');
    expect((await runtime.loginOutputLog('claude')?.snapshot())?.data.text).toBe('');

    first?.emitExit({ exitCode: 0, signal: null });
    expect(second?.killed).toBe(false);
    expect(runtime.sendLoginInput('claude', 'code\n')).toEqual(ok(undefined));
    expect(authCheckStatus).not.toHaveBeenCalled();

    second?.emitData('Open https://example.com/current\n');
    expect((await runtime.loginOutputLog('claude')?.snapshot())?.data.text).toBe(
      'Open https://example.com/current\n'
    );
    await runtime.dispose();
  });

  it('refreshes auth on the CLI the login ran on and releases login when the PTY exits', async () => {
    const ptySpawner = new FakePtySpawner();
    const authCheckStatus = vi.fn(async (_ctx: AgentAuthContext) => ({
      kind: 'unauthenticated' as const,
    }));
    const { runtime } = makeRuntime({ authCheckStatus, ptySpawner });
    await runtime.startLogin('claude', 'login', SELECTED_CLI);

    ptySpawner.processes[0]?.emitExit({ exitCode: 0, signal: null });

    await until('auth is re-checked after the login PTY exits', () => authCheckStatus.mock.calls.length, (n) => n >= 1);
    // 登进哪个账号由那份 CLI 决定 —— 登录后的状态必须问同一份。
    expect(authCheckStatus.mock.calls[0]?.[0].cli).toBe(SELECTED_CLI_PATH);
    await until('the login is released', () => runtime.sendLoginInput('claude', 'code\n').success, (sent) => !sent);
    await runtime.dispose();
  });

  describe('协议登录(acp-authenticate,#6335)', () => {
    const ACP_METHODS = [
      { kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' },
    ];
    const SPAWN = {
      command: '/managed/agy_acp_server',
      args: [],
      env: { NO_PROXY: '127.0.0.1,localhost' },
      cwd: '/home/ada',
    };

    function acpRuntime(
      authCheckStatus: Mock<(ctx: AgentAuthContext) => Promise<AgentAuthStatus>> = vi.fn(
        async (_ctx: AgentAuthContext): Promise<AgentAuthStatus> => ({ kind: 'authenticated' })
      )
    ) {
      const ptySpawner = new FakePtySpawner();
      const made = makeRuntime({ authMethods: ACP_METHODS, authCheckStatus, ptySpawner });
      const buildAcpSpawn = vi
        .spyOn(made.agentHost, 'buildAcpSpawn')
        .mockResolvedValue(ok(SPAWN) as Awaited<ReturnType<typeof made.agentHost.buildAcpSpawn>>);
      let settle!: (outcome: { kind: 'succeeded' } | { kind: 'failed'; message: string } | { kind: 'cancelled' }) => void;
      let captured: { methodId: string; signal: AbortSignal; onUrl?: (url: string) => void; spawn: unknown } | null = null;
      made.runtime.auth.runAcpAuthenticate = (options) => {
        captured = options;
        return new Promise((resolve) => {
          settle = resolve;
          options.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }));
        });
      };
      return { ...made, ptySpawner, buildAcpSpawn, authCheckStatus, settle: (o: Parameters<typeof settle>[0]) => settle(o), captured: () => captured };
    }

    it('起的是与真会话同一条 buildAcpSpawn,发厂商自报的 methodId,不开终端', async () => {
      const t = acpRuntime();
      await expect(t.runtime.startLogin('claude', 'google', SELECTED_CLI)).resolves.toEqual(ok(undefined));
      expect(t.buildAcpSpawn).toHaveBeenCalledWith('claude', { cwd: '/home/ada', runContext: SELECTED_CLI });
      expect(t.captured()?.methodId).toBe('oauth-personal');
      expect(t.captured()?.spawn).toEqual(SPAWN);
      expect(t.ptySpawner.processes).toHaveLength(0);
      expect(t.runtime.loginOutputLog('claude')).toBeNull();
      expect(t.runtime.install.getAuth('claude').login).toMatchObject({
        methodId: 'google',
        transport: 'acp-authenticate',
        pendingUrl: null,
        outcome: null,
      });
      await t.runtime.dispose();
    });

    it('厂商打出来的登录链接进 pendingUrl(备用链接);成功后重读登录态并清掉这一趟', async () => {
      const t = acpRuntime();
      await t.runtime.startLogin('claude', 'google', SELECTED_CLI);
      t.captured()?.onUrl?.('https://accounts.google.com/o/oauth2/v2/auth?x=1');
      expect(t.runtime.install.getAuth('claude').login?.pendingUrl?.url).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?x=1'
      );
      t.settle({ kind: 'succeeded' });
      await until('auth is re-checked after the login succeeds', () => t.authCheckStatus.mock.calls.length, (n) => n >= 1);
      expect(t.authCheckStatus.mock.calls[0]?.[0].cli).toBe(SELECTED_CLI_PATH);
      await until('the finished login is cleared', () => t.runtime.install.getAuth('claude').login, (login) => login === null);
      expect(t.runtime.install.getAuth('claude').status).toEqual({ kind: 'authenticated' });
      await t.runtime.dispose();
    });

    it('失败把厂商原话留在 outcome 里给界面', async () => {
      const t = acpRuntime(vi.fn(async () => ({ kind: 'unauthenticated' as const })));
      await t.runtime.startLogin('claude', 'google', SELECTED_CLI);
      t.settle({ kind: 'failed', message: 'authenticate: boom' });
      await until(
        'the failed login records its outcome',
        () => t.runtime.install.getAuth('claude').login?.outcome ?? null,
        (outcome) => outcome !== null,
      );
      expect(t.runtime.install.getAuth('claude').login?.outcome).toEqual({
        kind: 'failed',
        message: 'authenticate: boom',
      });
      await t.runtime.dispose();
    });

    it('取消 = abort 这一趟(runner 的 finally 收进程组),登录态清空、不去重读', async () => {
      const t = acpRuntime();
      await t.runtime.startLogin('claude', 'google', SELECTED_CLI);
      const signal = t.captured()!.signal;
      await expect(t.runtime.cancelLogin('claude')).resolves.toEqual(ok(undefined));
      expect(signal.aborted).toBe(true);
      expect(t.runtime.install.getAuth('claude').login).toBeNull();
      expect(t.authCheckStatus).not.toHaveBeenCalled();
      await t.runtime.dispose();
    });
  });

  describe('伴随程序自己的登录(auth.programs,#6335)', () => {
    const TUI_CLI: AgentRunContext = { ...SELECTED_CLI, cli: { kind: 'resolved', path: '/opt/managed/fake-tui' } };

    it('读数问的是那个程序的判据、拿的是那个程序的 CLI,落进 programAuth[程序] —— 主程序那一格不动', async () => {
      const main = vi.fn(async () => ({ kind: 'authenticated' as const }));
      const tui = vi.fn(async (_ctx: AgentAuthContext) => ({ kind: 'unauthenticated' as const, message: 'no tui creds' }));
      const { runtime } = makeRuntime({ authCheckStatus: main, companionAuth: { checkStatus: tui } });

      await expect(runtime.refreshAuthStatus('claude', TUI_CLI, 'claude-tui')).resolves.toEqual(
        ok({ kind: 'unauthenticated', message: 'no tui creds' })
      );
      expect(main).not.toHaveBeenCalled();
      expect(tui.mock.calls[0]?.[0].cli).toBe('/opt/managed/fake-tui');
      expect(runtime.install.getAuth('claude', 'claude-tui').status).toEqual({
        kind: 'unauthenticated',
        message: 'no tui creds',
      });
      expect(runtime.install.getAuth('claude').status).toEqual({ kind: 'unknown' });

      await runtime.refreshAuthStatus('claude', SELECTED_CLI);
      expect(runtime.install.getAuth('claude').status).toEqual({ kind: 'authenticated' });
      expect(runtime.install.getAuth('claude', 'claude-tui').status.kind).toBe('unauthenticated');
      await runtime.dispose();
    });

    it('登录走那个程序的方法与命令改写;与主程序的登录各占一个终端、互不顶替,输入按程序路由', async () => {
      const ptySpawner = new FakePtySpawner();
      const buildLoginCommand = vi.fn((ctx: { cli: string }) => ({ command: '/bin/sh', args: ['-c', 'wrap', ctx.cli] }));
      const { runtime } = makeRuntime({
        ptySpawner,
        companionAuth: { checkStatus: vi.fn(async () => ({ kind: 'unknown' as const })), buildLoginCommand },
      });

      await expect(runtime.startLogin('claude', 'tui-login', TUI_CLI, 'claude-tui')).resolves.toEqual(ok(undefined));
      await runtime.startLogin('claude', 'login', SELECTED_CLI);

      expect(ptySpawner.processes).toHaveLength(2);
      expect(ptySpawner.processes[0]?.spec).toMatchObject({
        command: '/bin/sh',
        args: ['-c', 'wrap', '/opt/managed/fake-tui'],
      });
      expect(buildLoginCommand).toHaveBeenCalledWith({ cli: '/opt/managed/fake-tui' }, 'tui-login');
      // 主程序那一趟没把伴随程序那一趟顶掉
      expect(ptySpawner.processes[0]?.killed).toBe(false);
      expect(runtime.install.getAuth('claude', 'claude-tui').login?.methodId).toBe('tui-login');
      expect(runtime.install.getAuth('claude').login?.methodId).toBe('login');

      expect(runtime.sendLoginInput('claude', 'a', 'claude-tui')).toEqual(ok(undefined));
      expect(runtime.sendLoginInput('claude', 'b')).toEqual(ok(undefined));
      expect(ptySpawner.processes[0]?.writes).toEqual(['a']);
      expect(ptySpawner.processes[1]?.writes).toEqual(['b']);

      await runtime.cancelLogin('claude', 'claude-tui');
      expect(ptySpawner.processes[0]?.killed).toBe(true);
      expect(ptySpawner.processes[1]?.killed).toBe(false);
      expect(runtime.install.getAuth('claude', 'claude-tui').login).toBeNull();
      await runtime.dispose();
    });

    it('没声明登录的程序 ⇒ 响亮失败,❌ 回落主程序的方法或判据', async () => {
      const ptySpawner = new FakePtySpawner();
      const main = vi.fn(async () => ({ kind: 'authenticated' as const }));
      const { runtime } = makeRuntime({ ptySpawner, authCheckStatus: main });

      const started = await runtime.startLogin('claude', 'login', SELECTED_CLI, 'claude-tui');
      expect(started.success).toBe(false);
      expect(ptySpawner.processes).toHaveLength(0);
      await expect(runtime.refreshAuthStatus('claude', SELECTED_CLI, 'claude-tui')).resolves.toEqual(
        ok({ kind: 'unknown' })
      );
      expect(main).not.toHaveBeenCalled();
      await runtime.dispose();
    });
  });

  it('deduplicates concurrent auth status refreshes on the same CLI', async () => {
    let resolveProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const authCheckStatus = vi.fn(async () => {
      await probeGate;
      return { kind: 'authenticated' as const };
    });
    const { runtime } = makeRuntime({ authCheckStatus });

    const first = runtime.refreshAuthStatus('claude', SELECTED_CLI);
    const second = runtime.refreshAuthStatus('claude', SELECTED_CLI);

    await until('the first refresh starts its auth check', () => authCheckStatus.mock.calls.length, (n) => n >= 1);
    expect(authCheckStatus).toHaveBeenCalledTimes(1);
    resolveProbe();
    await expect(Promise.all([first, second])).resolves.toEqual([
      ok({ kind: 'authenticated' }),
      ok({ kind: 'authenticated' }),
    ]);
    await runtime.dispose();
  });

  it('does not merge refreshes on different CLIs, and the newer one owns the published status', async () => {
    let resolveSelected!: () => void;
    const selectedGate = new Promise<void>((resolve) => {
      resolveSelected = resolve;
    });
    const authCheckStatus = vi.fn(async (ctx: AgentAuthContext): Promise<AgentAuthStatus> => {
      if (ctx.cli === SELECTED_CLI_PATH) {
        await selectedGate;
        return { kind: 'authenticated' };
      }
      return { kind: 'unauthenticated' };
    });
    const { runtime } = makeRuntime({ authCheckStatus });

    const stale = runtime.refreshAuthStatus('claude', SELECTED_CLI);
    await until('the stale refresh starts its auth check', () => authCheckStatus.mock.calls.length, (n) => n >= 1);
    expect(authCheckStatus).toHaveBeenCalledTimes(1);
    const newer = await runtime.refreshAuthStatus('claude', OTHER_CLI);
    resolveSelected();

    expect(authCheckStatus).toHaveBeenCalledTimes(2);
    expect(newer).toEqual(ok({ kind: 'unauthenticated' }));
    await expect(stale).resolves.toEqual(ok({ kind: 'authenticated' }));
    // 慢的那次读数晚到,❌ 不许盖掉较新的那次发布出去的状态。
    expect(runtime.install.getAuth('claude').status).toEqual({ kind: 'unauthenticated' });
    await runtime.dispose();
  });
});

/**
 * #6264「登录已失效」的状态迁移:CLI 照文件答「已登录」时,会话报的鉴权失败要能把读数翻过来,
 * 重新登录成功 / 之后一次会话成功再翻回去。
 */
describe('AgentConfigRuntime sign-in expiry (#6264)', () => {
  const signedIn = () => vi.fn(async (_ctx: AgentAuthContext): Promise<AgentAuthStatus> => ({ kind: 'authenticated', account: 'ada@example.com' }));

  it('标上之后:读数立刻翻成「登录已失效」,之后再探 CLI(它仍答已登录)也不翻回去', async () => {
    const authCheckStatus = signedIn();
    const { runtime } = makeRuntime({ authCheckStatus });
    expect(await runtime.refreshAuthStatus('claude', SELECTED_CLI)).toEqual(ok({ kind: 'authenticated', account: 'ada@example.com' }));

    expect(await runtime.markAuthExpired('claude')).toEqual(ok(undefined));
    expect(runtime.install.getAuth('claude').status).toEqual({ kind: 'unauthenticated', reason: 'expired' });

    expect(await runtime.refreshAuthStatus('claude', SELECTED_CLI)).toEqual(ok({ kind: 'unauthenticated', reason: 'expired' }));
    await runtime.dispose();
  });

  it('CLI 自己说没登录时照它说(退出登录了),不叠「失效」', async () => {
    const { runtime } = makeRuntime({ authCheckStatus: vi.fn(async () => ({ kind: 'unauthenticated' as const })) });
    await runtime.markAuthExpired('claude');
    expect(await runtime.refreshAuthStatus('claude', SELECTED_CLI)).toEqual(ok({ kind: 'unauthenticated' }));
    await runtime.dispose();
  });

  it('CLI 说没登录:盘上那一格也撤掉 —— 重启后 ❌ 在探到之前先说成「登录已失效」(10-07 没 key 的 MiMo)', async () => {
    let disk: Record<string, number> = {};
    const persistence: AuthExpiryPersistence = {
      load: async () => ({ ...disk }),
      save: async (marks) => {
        disk = { ...marks };
      },
    };
    const marks = new AuthExpiryMarks(persistence);
    const a = makeRuntime({ authExpiry: marks, authCheckStatus: vi.fn(async () => ({ kind: 'unauthenticated' as const })) });
    await a.runtime.markAuthExpired('claude');
    await a.runtime.refreshAuthStatus('claude', SELECTED_CLI);
    await marks.flushed();
    expect(disk).toEqual({});
    await a.runtime.dispose();
  });

  /**
   * #1163 凭据是**用户自己递进来的**(API key / 中转令牌):「登录已失效」这一格不成立 ——
   * 没有那份 Anthropic 登录可续,所以既不说失效,盘上旧版本留下的标记也一并撤掉。
   */
  it('凭据是用户自己递的 key / 中转令牌:不说「登录已失效」,盘上那一格也撤掉(#1163)', async () => {
    let disk: Record<string, number> = {};
    const persistence: AuthExpiryPersistence = {
      load: async () => ({ ...disk }),
      save: async (marks) => {
        disk = { ...marks };
      },
    };
    const marks = new AuthExpiryMarks(persistence);
    const { runtime } = makeRuntime({
      authExpiry: marks,
      authCheckStatus: vi.fn(async () => ({
        kind: 'authenticated' as const,
        credentialKind: 'api-key' as const,
      })),
    });
    // 旧版本在这种机器上留下的标记(凭据被拒时标上,而之后没有任何一条路能撤:能撤的两条都要求
    // 「这家的登录」——一次成功会话或一次 `claude auth login`——而他两条都没有)。
    await runtime.markAuthExpired('claude');
    expect(await runtime.refreshAuthStatus('claude', SELECTED_CLI)).toEqual(
      ok({ kind: 'authenticated', credentialKind: 'api-key' })
    );
    await marks.flushed();
    expect(disk).toEqual({});
    await runtime.dispose();
  });

  it('之后一次会话成功:撤掉标记,按上一次那份 CLI 重读出真读数', async () => {
    const authCheckStatus = signedIn();
    const { runtime } = makeRuntime({ authCheckStatus });
    await runtime.refreshAuthStatus('claude', SELECTED_CLI);
    await runtime.markAuthExpired('claude');

    expect(await runtime.clearAuthExpired('claude')).toEqual(ok(undefined));
    expect(runtime.install.getAuth('claude').status).toEqual({ kind: 'authenticated', account: 'ada@example.com' });
    expect(authCheckStatus.mock.calls.at(-1)?.[0].cli).toBe(SELECTED_CLI_PATH);
    await runtime.dispose();
  });

  it('没标着时撤销是空操作(每一轮成功都会来一次,❌ 每次都去跑 CLI)', async () => {
    const authCheckStatus = signedIn();
    const { runtime } = makeRuntime({ authCheckStatus });
    await runtime.refreshAuthStatus('claude', SELECTED_CLI);
    const calls = authCheckStatus.mock.calls.length;
    await runtime.clearAuthExpired('claude');
    expect(authCheckStatus.mock.calls.length).toBe(calls);
    await runtime.dispose();
  });

  it('在这台机器上重新登录成功(登录命令 0 退出)就撤掉;取消(非 0 退出)不撤', async () => {
    const ptySpawner = new FakePtySpawner();
    const authCheckStatus = signedIn();
    const { runtime } = makeRuntime({ authCheckStatus, ptySpawner });
    await runtime.markAuthExpired('claude');

    await runtime.startLogin('claude', 'login', SELECTED_CLI);
    ptySpawner.processes[0]?.emitExit({ exitCode: 1, signal: null });
    await until('auth is re-checked after the cancelled login', () => authCheckStatus.mock.calls.length, (n) => n >= 1);
    await until(
      'the cancelled login keeps the expired mark',
      () => runtime.install.getAuth('claude').status,
      (status) => deepEquals(status, { kind: 'unauthenticated', reason: 'expired' }),
    );

    await runtime.startLogin('claude', 'login', SELECTED_CLI);
    ptySpawner.processes[1]?.emitExit({ exitCode: 0, signal: null });
    await until(
      'the successful login clears the expired mark',
      () => runtime.install.getAuth('claude').status,
      (status) => deepEquals(status, { kind: 'authenticated', account: 'ada@example.com' }),
    );
    await runtime.dispose();
  });

  it('模型清单那一组的凭据读数跟着失效:「有凭据」翻成「没凭据」,默认才会挪到咕咕的模型', async () => {
    const { runtime } = makeRuntime({ modelCredential: async () => 'credentialed' });
    expect(await runtime.modelCredential('claude', 'opus', SELECTED_CLI)).toEqual(ok('credentialed'));
    await runtime.markAuthExpired('claude');
    expect(await runtime.modelCredential('claude', 'opus', SELECTED_CLI)).toEqual(ok('uncredentialed'));
    await runtime.dispose();
  });

  it('标记落盘,重启后(新的 worker)读回来并直接发布「登录已失效」', async () => {
    let disk: Record<string, number> = {};
    const persistence: AuthExpiryPersistence = {
      load: async () => ({ ...disk }),
      save: async (marks) => {
        disk = { ...marks };
      },
    };
    const first = new AuthExpiryMarks(persistence);
    const a = makeRuntime({ authExpiry: first });
    await a.runtime.markAuthExpired('claude');
    await first.flushed();
    expect(Object.keys(disk)).toEqual(['claude']);
    await a.runtime.dispose();

    const b = makeRuntime({ authExpiry: new AuthExpiryMarks(persistence) });
    await until(
      'the restarted worker publishes the persisted expired mark',
      () => b.runtime.install.getAuth('claude').status,
      (status) => deepEquals(status, { kind: 'unauthenticated', reason: 'expired' }),
    );
    await b.runtime.dispose();
  });

  it('不认识的 harness 报错,❌ 静默记下一个不存在的标记', async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.markAuthExpired('nope');
    expect(result.success).toBe(false);
    await runtime.dispose();
  });
});

function makeRuntime(
  options: {
    authCheckStatus?: (ctx: AgentAuthContext) => Promise<AgentAuthStatus>;
    logger?: Logger;
    ptySpawner?: PtySpawner;
    /** 这家声明的「别的电脑上登录」参数;缺席 = 没有。 */
    headlessArgs?: string[];
    authExpiry?: AuthExpiryMarks;
    modelCredential?: () => Promise<'credentialed' | 'uncredentialed' | 'unknown'>;
    authMethods?: unknown[];
    subscriptionUsage?: () => Promise<SubscriptionUsageReading>;
    usageRefresh?: 'on-open' | 'on-demand';
    isolatedCredentialFs?: boolean;
    /** 伴随程序 `claude-tui`(认领 tui)自己的登录(#6335)。 */
    companionAuth?: {
      checkStatus: (ctx: AgentAuthContext) => Promise<AgentAuthStatus>;
      buildLoginCommand?: (ctx: { cli: string }, methodId: string) => { command: string; args: string[] } | null;
    };
  } = {}
) {
  const exec = new FakeExecutionContext();
  const fs = new MemoryPluginFs();
  const mcpServers: McpServerRegistration[] = [];
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  registry.register({
    metadata: {
      id: 'claude',
      name: 'Claude Code',
      description: 'Test provider',
      websiteUrl: 'https://example.com',
    },
    capabilities: {
      acp: { kind: 'none' },
      subscription: options.subscriptionUsage ? { kind: 'supported', usageRefresh: options.usageRefresh ?? 'on-demand' } : { kind: 'none' },
      // 真 provider 恒有 sessionBundle(必答);宿主的依赖探针要从它读 `selfUpdate`(#6186)。
      // 这个假 provider 不声明关更新的通道 ⇒ 空声明,❌ 省掉整格(那不是任何真 provider 的形状)。
      sessionBundle: {},
      auth: {
        kind: 'supported',
        methods: options.authMethods ?? [
          {
            kind: 'cli-login',
            id: 'login',
            name: 'Login',
            args: [],
            ...(options.headlessArgs ? { headlessArgs: options.headlessArgs } : {}),
          },
        ],
        ...(options.companionAuth
          ? {
              programs: {
                'claude-tui': {
                  methods: [{ kind: 'cli-login', id: 'tui-login', name: 'TUI login', args: ['--login'] }],
                },
              },
            }
          : {}),
      },
      autoApprove: { kind: 'none' },
      effort: { kind: 'none' },
      hooks: { kind: 'none' },
      hostDependency: {
        binaryNames: ['fake-agent'],
        skipVersionProbe: true,
        installCommands: {},
        updates: { kind: 'none' },
        ...(options.companionAuth
          ? {
              companions: [
                {
                  id: 'claude-tui',
                  name: 'Claude TUI',
                  legs: ['tui'],
                  dependency: {
                    binaryNames: ['fake-tui'],
                    skipVersionProbe: true,
                    installCommands: {},
                    updates: { kind: 'none' },
                  },
                },
              ],
            }
          : {}),
      },
      mcp: { kind: 'supported', supportsHttp: true },
      models: { kind: 'none' },
      plugins: { kind: 'none' },
      prompt: { kind: 'none' },
      sessions: { kind: 'none' },
      trust: { kind: 'none' },
    },
    assets: {},
    validate: () => [],
    behavior: {
      ...(options.subscriptionUsage ? { subscription: { readPlan: async () => ({ payer: 'subscription' }), readUsage: options.subscriptionUsage } } : {}),
      auth: {
        checkStatus: options.authCheckStatus ?? vi.fn(async () => ({ kind: 'unknown' as const })),
        ...(options.modelCredential ? { modelCredential: options.modelCredential } : {}),
        ...(options.companionAuth ? { programs: { 'claude-tui': options.companionAuth } } : {}),
      },
      mcp: {
        readServers: vi.fn(async () => [...mcpServers]),
        writeServers: vi.fn(async (_pluginFs, servers) => {
          mcpServers.splice(0, mcpServers.length, ...servers);
        }),
        removeServer: vi.fn(async (_pluginFs, name) => {
          const index = mcpServers.findIndex((server) => server.name === name);
          if (index >= 0) mcpServers.splice(index, 1);
        }),
      },
    },
  } as unknown as CLIAgentPluginProvider);
  const logger = options.logger ?? noopLogger;
  const scope = createScope({ label: 'test-agent-config', logger });
  const agentHost = new AgentPluginHost({
    scope,
    registry,
    exec,
    fs,
    homeDir: '/home/ada',
    ...(options.isolatedCredentialFs ? { agentHome: { provision: async () => null, createFs: () => new MemoryPluginFs() } } : {}),
  });

  return {
    exec,
    agentHost,
    runtime: new AgentConfigRuntime({
      scope,
      agentHost,
      ptySpawner: options.ptySpawner ?? new FakePtySpawner(),
      logger,
      ...(options.authExpiry ? { authExpiry: options.authExpiry } : {}),
    }),
  };
}


describe('subscription connection isolation', () => {
  const personal = { ...SELECTED_CLI, connectionId: 'personal' };
  const work = { ...SELECTED_CLI, connectionId: 'work' };

  it('keeps parallel login terminals, input and live status in separate connection scopes', async () => {
    const ptySpawner = new FakePtySpawner();
    const { runtime } = makeRuntime({ ptySpawner });
    expect(await runtime.startLogin('claude', 'login', personal, undefined, {}, 'personal')).toEqual(ok(undefined));
    expect(await runtime.startLogin('claude', 'login', work, undefined, {}, 'work')).toEqual(ok(undefined));
    runtime.sendLoginInput('claude', 'work-code', undefined, 'work');
    expect(ptySpawner.processes[0].writes).toEqual([]);
    expect(ptySpawner.processes[1].writes).toEqual(['work-code']);
    expect(runtime.install.getAuth('claude').login).toBeNull();
    expect(runtime.install.getAuth('claude', undefined, 'personal').login).not.toBeNull();
    await runtime.cancelLogin('claude', undefined, 'personal');
    expect(ptySpawner.processes[0].killed).toBe(true);
    expect(ptySpawner.processes[1].killed).toBe(false);
    await runtime.dispose();
  });

  it('never reuses another account’s on-demand quota and never polls on a normal read', async () => {
    const readUsage = vi.fn(async (): Promise<SubscriptionUsageReading> => ({ kind: 'windows', readAt: 1, windows: [{ usedPercent: 42, windowMinutes: 300 }] }));
    const { runtime } = makeRuntime({ subscriptionUsage: readUsage });
    await runtime.readSubscriptionUsage('claude', personal, true);
    expect(await runtime.readSubscriptionUsage('claude', work, false)).toMatchObject({ data: { reason: 'not-read-yet' } });
    expect(await runtime.readSubscriptionUsage('claude', personal, false)).toMatchObject({ data: { kind: 'windows', windows: [{ usedPercent: 42 }] } });
    expect(readUsage).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('attributes an old session’s auth rejection to its bound connection and preserves the selected account', async () => {
    const { runtime } = makeRuntime({ authCheckStatus: async () => ({ kind: 'authenticated' }), modelCredential: async () => 'credentialed' });
    await runtime.refreshAuthStatus('claude', personal, undefined, 'personal');
    await runtime.refreshAuthStatus('claude', work);
    await runtime.markAuthExpired('claude', 'personal');
    expect(runtime.install.getAuth('claude').status.kind).toBe('authenticated');
    expect(runtime.install.getAuth('claude', undefined, 'personal').status).toMatchObject({ kind: 'unauthenticated', reason: 'expired' });
    expect(await runtime.modelCredential('claude', 'model', work)).toEqual(ok('credentialed'));
    expect(await runtime.modelCredential('claude', 'model', personal)).toEqual(ok('uncredentialed'));
    await runtime.markAuthExpired('claude', 'work');
    expect(runtime.install.getAuth('claude').status.kind).toBe('unauthenticated');
    await runtime.clearAuthExpired('claude', 'work');
    expect(runtime.install.getAuth('claude').status.kind).toBe('authenticated');
    await runtime.dispose();
  });
});


it('a login started before switching cannot republish the old account over the current connection', async () => {
  const ptySpawner = new FakePtySpawner();
  const authCheckStatus = vi.fn(async (ctx: AgentAuthContext): Promise<AgentAuthStatus> => ({ kind: 'authenticated', account: ctx.env.ACCOUNT_NAME })).mockResolvedValueOnce({ kind: 'unauthenticated' });
  const { runtime } = makeRuntime({ ptySpawner, authCheckStatus });
  const personal = { ...SELECTED_CLI, connectionId: 'personal', env: { ACCOUNT_NAME: 'personal' } };
  const work = { ...SELECTED_CLI, connectionId: 'work', env: { ACCOUNT_NAME: 'work' } };
  await runtime.startLogin('claude', 'login', personal);
  await runtime.refreshAuthStatus('claude', work);
  ptySpawner.processes[0].emitExit({ exitCode: 0, signal: null });
  await until('the old login has been checked', () => authCheckStatus.mock.calls.length >= 3);
  expect(runtime.install.getAuth('claude').status).toMatchObject({ kind: 'authenticated', account: 'work' });
  await runtime.dispose();
});


it('signing in again clears cached quota and discards an older in-flight reading', async () => {
  const reading = { kind: 'windows' as const, readAt: 1, windows: [{ usedPercent: 42, windowMinutes: 300 }] };
  const usage = vi.fn(async (): Promise<SubscriptionUsageReading> => reading);
  const { runtime } = makeRuntime({ subscriptionUsage: usage });
  await runtime.readSubscriptionUsage('claude', SELECTED_CLI, true);
  let release!: (reading: SubscriptionUsageReading) => void;
  usage.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const inFlight = runtime.readSubscriptionUsage('claude', SELECTED_CLI, true);
  await until('the previous credential is being queried', () => usage.mock.calls.length === 2);
  await runtime.startLogin('claude', 'login', SELECTED_CLI);
  expect(await runtime.readSubscriptionUsage('claude', SELECTED_CLI, false)).toMatchObject({ data: { reason: 'not-read-yet' } });
  release(reading);
  expect(await inFlight).toMatchObject({ data: { reason: 'not-read-yet' } });
  expect(usage).toHaveBeenCalledTimes(2);
  await runtime.dispose();
});


it('opening a subscription reads automatically and merges concurrent reads of that connection', async () => {
  let release!: (reading: SubscriptionUsageReading) => void;
  const usage = vi.fn(() => new Promise<SubscriptionUsageReading>(resolve => { release = resolve; }));
  const { runtime } = makeRuntime({ subscriptionUsage: usage, usageRefresh: 'on-open' });
  const first = runtime.readSubscriptionUsage('claude', SELECTED_CLI, false);
  const second = runtime.readSubscriptionUsage('claude', SELECTED_CLI, false);
  await until('the automatic read is sent once', () => usage.mock.calls.length === 1);
  const reading = { kind: 'windows' as const, readAt: 123, windows: [{ usedPercent: 42, windowMinutes: 300 }] };
  release(reading);
  expect(await first).toEqual(ok(reading));
  expect(await second).toEqual(ok(reading));
  expect(usage).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});

it('a failed refresh preserves the last successful figures and timestamp without leaking them to another connection', async () => {
  const usage = vi.fn(async (): Promise<SubscriptionUsageReading> => ({ kind: 'windows', readAt: 123, windows: [{ usedPercent: 42, windowMinutes: 300 }] }));
  const { runtime } = makeRuntime({ subscriptionUsage: usage, usageRefresh: 'on-open' });
  await runtime.readSubscriptionUsage('claude', SELECTED_CLI, false);
  usage.mockResolvedValue({ kind: 'unavailable', reason: 'error', readAt: 456, message: 'rate limited' });
  expect(await runtime.readSubscriptionUsage('claude', SELECTED_CLI, false)).toMatchObject({ data: { kind: 'windows', readAt: 123, refreshError: 'rate limited', windows: [{ usedPercent: 42 }] } });
  expect(await runtime.readSubscriptionUsage('claude', { ...SELECTED_CLI, connectionId: 'different' }, false)).toMatchObject({ data: { kind: 'unavailable', readAt: 456 } });
  await runtime.dispose();
});

it('a failed host refresh also preserves successful quota in its original connection only', async () => {
  const usage = vi.fn(async (): Promise<SubscriptionUsageReading> => ({ kind: 'windows', readAt: 123, windows: [{ usedPercent: 42, windowMinutes: 300 }] }));
  const { runtime } = makeRuntime({ subscriptionUsage: usage, usageRefresh: 'on-open' });
  await runtime.readSubscriptionUsage('claude', SELECTED_CLI, false);
  usage.mockRejectedValue(new Error('host offline'));
  expect(await runtime.readSubscriptionUsage('claude', SELECTED_CLI, false)).toMatchObject({ data: {
    kind: 'windows', readAt: 123, refreshError: expect.stringContaining('host offline'), windows: [{ usedPercent: 42 }],
  } });
  expect(await runtime.readSubscriptionUsage('claude', { ...SELECTED_CLI, connectionId: 'different' }, false)).toMatchObject({ data: { kind: 'unavailable', reason: 'error' } });
  await runtime.dispose();
});

it('refuses to start login over an authenticated account without clearing its status or cached quota', async () => {
  const ptySpawner = new FakePtySpawner();
  const { runtime } = makeRuntime({ ptySpawner, authCheckStatus: async () => ({ kind: 'authenticated', account: 'existing@example.test' }),
    subscriptionUsage: async () => ({ kind: 'windows', readAt: 123, windows: [{ windowMinutes: 300, usedPercent: 42 }] }) });
  const existing = { ...SELECTED_CLI, connectionId: 'existing' };
  await runtime.refreshAuthStatus('claude', existing);
  await runtime.readSubscriptionUsage('claude', existing, true);
  expect((await runtime.startLogin('claude', 'login', existing, undefined, {}, 'existing')).success).toBe(false);
  expect(ptySpawner.processes).toHaveLength(0);
  expect(runtime.install.getAuth('claude').status).toMatchObject({ kind: 'authenticated', account: 'existing@example.test' });
  expect(await runtime.readSubscriptionUsage('claude', existing, false)).toMatchObject({ data: { kind: 'windows', readAt: 123 } });
  await runtime.dispose();
});

it('refuses an explicit native connection login even if a stale UI claims it is signed out', async () => {
  const ptySpawner = new FakePtySpawner();
  const check = vi.fn(async (): Promise<AgentAuthStatus> => ({ kind: 'unauthenticated' }));
  const { runtime } = makeRuntime({ ptySpawner, authCheckStatus: check });
  const result = await runtime.startLogin('claude', 'login', { ...SELECTED_CLI, connectionId: 'native' }, undefined, {}, 'native');
  expect(result.success).toBe(false);
  expect(ptySpawner.processes).toHaveLength(0);
  await runtime.dispose();
});

it('cancelling a new isolated login preserves the original account, quota and login process scope', async () => {
  const ptySpawner = new FakePtySpawner();
  const { runtime } = makeRuntime({ ptySpawner, isolatedCredentialFs: true,
    authCheckStatus: async (ctx) => ctx.env.ACCOUNT_NAME === 'original' ? { kind: 'authenticated', account: 'original@example.test' } : { kind: 'unauthenticated' },
    subscriptionUsage: async () => ({ kind: 'windows', readAt: 123, windows: [{ windowMinutes: 300, usedPercent: 42 }] }) });
  const original = { ...SELECTED_CLI, connectionId: 'original', env: { ...HOST_ENV, ACCOUNT_NAME: 'original' } };
  const addition = { ...SELECTED_CLI, connectionId: 'addition', credentialHome: '/private/addition', configRootEnv: { CLAUDE_CONFIG_DIR: '/private/addition/.claude' }, env: { ...HOST_ENV, ACCOUNT_NAME: 'addition' } };
  await runtime.refreshAuthStatus('claude', original);
  await runtime.readSubscriptionUsage('claude', original, true);
  expect(await runtime.startLogin('claude', 'login', addition, undefined, {}, 'addition')).toEqual(ok(undefined));
  expect(ptySpawner.processes).toHaveLength(1);
  expect(ptySpawner.processes[0].spec.env?.CLAUDE_CONFIG_DIR).toBe('/private/addition/.claude');
  await runtime.cancelLogin('claude', undefined, 'addition');
  expect(ptySpawner.processes[0].killed).toBe(true);
  expect(runtime.install.getAuth('claude').status).toMatchObject({ kind: 'authenticated', account: 'original@example.test' });
  expect(await runtime.readSubscriptionUsage('claude', original, false)).toMatchObject({ data: { kind: 'windows', readAt: 123 } });
  await runtime.dispose();
});
