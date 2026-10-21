import { describe, expect, it, vi } from 'vitest';
import type { RemotePortLink } from '@shared/remote-port-link';
import type { SshKeyInstallOutcome, SshPrompt } from '@shared/ssh-prompt';
import { createPortForwards, PortForwardError, type ForwardChild, type ForwardSpec, type PortForwardDeps } from './port-forward';
import type { DirectTerminalAskpass, SshPromptOutcome } from './ssh-connect';

type FakeChild = ForwardChild & {
  args: string[];
  killed: boolean;
  exit(info?: { exitCode: number | null; signal?: number | string | null }): void;
  stderr(text: string): void;
};

function fakeChild(args: string[]): FakeChild {
  const exits: Array<(info: { exitCode: number | null; signal: number | string | null }) => void> = [];
  const errs: Array<(chunk: string) => void> = [];
  const child: FakeChild = {
    args,
    killed: false,
    onExit: (h) => void exits.push(h),
    onStderr: (h) => void errs.push(h),
    kill() {
      if (child.killed) return;
      child.killed = true;
      child.exit({ exitCode: null, signal: 'SIGTERM' });
    },
    exit(info = { exitCode: 255 }) {
      for (const h of exits) h({ exitCode: info.exitCode, signal: info.signal ?? null });
    },
    stderr(text) {
      for (const h of errs) h(text);
    },
  };
  return child;
}

function fakeAskpass() {
  const promptListeners: Array<(p: SshPrompt | null) => void> = [];
  const settled: Array<(p: SshPrompt, o: SshPromptOutcome) => void> = [];
  let current: SshPrompt | null = null;
  const askpass: DirectTerminalAskpass & {
    ask(p: SshPrompt): void;
    closed: boolean;
    extras: Array<{ installKey?: boolean } | undefined>;
    authenticatedCalls: number;
    keyListeners: Array<(o: SshKeyInstallOutcome) => void>;
  } = {
    env: { SSH_ASKPASS: '/tmp/askpass' },
    closed: false,
    extras: [],
    authenticatedCalls: 0,
    keyListeners: [],
    authenticated: () => void (askpass.authenticatedCalls += 1),
    onKeyInstall: (l) => void askpass.keyListeners.push(l),
    onPrompt: (l) => void promptListeners.push(l),
    onSettled: (l) => void settled.push(l),
    answer(promptId, value, extra) {
      if (!current || current.id !== promptId) return false;
      askpass.extras.push(extra);
      const p = current;
      current = null;
      for (const l of settled) l(p, value === null ? 'cancelled' : 'answered');
      for (const l of promptListeners) l(null);
      return true;
    },
    newRound: () => undefined,
    cancelAll: () => undefined,
    close: async () => {
      askpass.closed = true;
    },
    ask(p) {
      current = p;
      for (const l of promptListeners) l(p);
    },
  };
  return askpass;
}

function setup(
  options: {
    busy?: number[];
    spec?: Partial<ForwardSpec> | null;
    askpass?: DirectTerminalAskpass;
    onKeyInstall?: PortForwardDeps['onKeyInstall'];
  } = {}
) {
  const children: FakeChild[] = [];
  const listening = new Set<number>();
  const links: RemotePortLink[] = [];
  const resolve = vi.fn(async (input: { deviceId: string; sessionId: string; localPort: number; remotePort: number }) =>
    options.spec === null
      ? null
      : ({
          command: 'ssh',
          args: ['-L', `127.0.0.1:${input.localPort}:localhost:${input.remotePort}`, 'box'],
          label: 'me@box',
          classifyExit: (info: { exitCode: number | null; tail: string }) => ({
            reason: info.exitCode === 255 && /Permission denied/.test(info.tail) ? 'auth' : 'network',
          }),
          ...(options.askpass ? { askpass: options.askpass } : {}),
          ...(options.spec ?? {}),
        }) as ForwardSpec
  );
  let nextFree = 50_000;
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  const deps: PortForwardDeps = {
    resolve,
    spawn: (_command, args) => {
      const child = fakeChild(args);
      children.push(child);
      for (const waiter of waiters) {
        if (!waiter.holds()) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
      return child;
    },
    isPortFree: async (port) => !(options.busy ?? []).includes(port),
    freePort: async () => nextFree++,
    canConnect: async (port) => listening.has(port),
    emit: (link) => links.push(link),
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 0));
    },
    pollMs: 0,
    readyTimeoutMs: 60_000,
    ...(options.onKeyInstall ? { onKeyInstall: options.onKeyInstall } : {}),
  };
  const forwards = createPortForwards(deps);
  /** 让最近起的那个 ssh「开始监听」它的本机端口。 */
  const listen = () => {
    const child = children[children.length - 1]!;
    const spec = child.args.find((a) => a.startsWith('127.0.0.1:'))!;
    listening.add(Number(spec.split(':')[1]));
  };
  /** 等 ssh 起到这一步:每起一个就重判一次(已成立就立刻)。产品在 spawn 返回后同步挂好退出 / stderr 监听。 */
  const until = (check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) resolve();
      else waiters.add({ holds: check, resolve });
    });
  return { forwards, children, listening, links, resolve, listen, until };
}

describe('端口转发(会话右侧工作区的浏览器打开那台机器的 localhost)', () => {
  it('本机端口优先与远端同号;ssh 真的在监听才算转好;同一端口的第二个页签复用同一条', async () => {
    const t = setup();
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'tab-a' });
    await t.until(() => t.children.length === 1);
    expect(t.children[0]!.args).toContain('127.0.0.1:3000:localhost:3000');
    t.listen();
    expect(await opening).toBe(3000);
    expect(t.links.at(-1)).toMatchObject({ phase: 'ready', localPort: 3000, label: 'me@box' });

    expect(await t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'tab-b' })).toBe(3000);
    expect(t.children).toHaveLength(1);
  });

  it('这台电脑上同号端口被别的程序占着:换一个空闲端口,❌ 把人带到本机那个服务上', async () => {
    const t = setup({ busy: [3000] });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    expect(t.children[0]!.args).toContain('127.0.0.1:50000:localhost:3000');
    t.listen();
    expect(await opening).toBe(50000);
  });

  it('最后一个持有者放手才撤:杀掉 ssh、报 closed', async () => {
    const t = setup();
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 8080, holder: 'a' });
    await t.until(() => t.children.length === 1);
    t.listen();
    await opening;
    await t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 8080, holder: 'b' });
    t.forwards.release({ deviceId: 'd1', remotePort: 8080, holder: 'a' });
    expect(t.children[0]!.killed).toBe(false);
    t.forwards.release({ deviceId: 'd1', remotePort: 8080, holder: 'b' });
    expect(t.children[0]!.killed).toBe(true);
    expect(t.forwards.size()).toBe(0);
    expect(t.links.at(-1)).toMatchObject({ phase: 'closed', localPort: null });
  });

  it('转好之后 ssh 断了(睡眠 / 换网):报 closed;下次打开再转一条,仍用原来那个本机端口', async () => {
    const t = setup({ busy: [3000] });
    const first = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    t.listen();
    expect(await first).toBe(50000);
    t.listening.clear();
    t.children[0]!.exit({ exitCode: 255 });
    expect(t.links.at(-1)).toMatchObject({ phase: 'closed' });

    const again = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 2);
    expect(t.children[1]!.args).toContain('127.0.0.1:50000:localhost:3000');
    t.listen();
    expect(await again).toBe(50000);
  });

  it('连不上:按 ssh 的退出认原因(认证没过),报 failed', async () => {
    const t = setup();
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    t.children[0]!.stderr('me@box: Permission denied (publickey).\n');
    t.children[0]!.exit({ exitCode: 255 });
    await expect(opening).rejects.toMatchObject({ reason: 'auth' });
    expect(t.links.at(-1)).toMatchObject({ phase: 'failed', reason: 'auth' });
  });

  it('那台机器不许转发 / 本机端口绑不上:前者如实报,后者换端口重试一次', async () => {
    const refused = setup();
    const a = refused.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await refused.until(() => refused.children.length === 1);
    refused.children[0]!.stderr('channel_setup_fwd_listener_tcpip: administratively prohibited\nCould not request local forwarding.\n');
    refused.children[0]!.exit({ exitCode: 255 });
    await expect(a).rejects.toMatchObject({ reason: 'forward-refused' });

    const raced = setup();
    const b = raced.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await raced.until(() => raced.children.length === 1);
    raced.children[0]!.stderr('bind [127.0.0.1]:3000: Address already in use\n');
    raced.children[0]!.exit({ exitCode: 255 });
    await raced.until(() => raced.children.length === 2);
    expect(raced.children[1]!.args).toContain('127.0.0.1:50000:localhost:3000');
    raced.listen();
    expect(await b).toBe(50000);
  });

  it('不是用 SSH 装上的机器(远程隧道):没有直连通道,❌ 起任何进程', async () => {
    const t = setup({ spec: null });
    await expect(t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' })).rejects.toBeInstanceOf(
      PortForwardError
    );
    expect(t.children).toHaveLength(0);
    expect(t.links.at(-1)).toMatchObject({ phase: 'failed', reason: 'not-direct' });
  });

  it('ssh 要密码:提问随状态报出去;人取消 = 报 cancelled,❌ 当成认证失败', async () => {
    const askpass = fakeAskpass();
    const t = setup({ askpass });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    const prompt: SshPrompt = { id: 'p1', kind: 'password', message: 'me@box password:' };
    askpass.ask(prompt);
    expect(t.links.at(-1)).toMatchObject({ phase: 'connecting', prompt: { id: 'p1' } });
    expect(t.forwards.answerPrompt({ deviceId: 'd1', remotePort: 3000, promptId: 'p1', value: null })).toBe(true);
    t.children[0]!.stderr('Permission denied\n');
    t.children[0]!.exit({ exitCode: 255 });
    await expect(opening).rejects.toMatchObject({ reason: 'cancelled' });
    expect(askpass.closed).toBe(true);
  });

  it('#6264「下次免密」:勾选随回答转给 askpass;转好 = 登上了,告诉 askpass 去装;装完的结果带着机器名报出去(转发关了也报)', async () => {
    const askpass = fakeAskpass();
    const reports: Array<[string, SshKeyInstallOutcome]> = [];
    const t = setup({ askpass, onKeyInstall: (label, outcome) => reports.push([label, outcome]) });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    askpass.ask({ id: 'p1', kind: 'password', message: 'me@box password:', offerKeyInstall: true });
    expect(t.forwards.answerPrompt({ deviceId: 'd1', remotePort: 3000, promptId: 'p1', value: 'pw', installKey: true })).toBe(true);
    expect(askpass.extras).toEqual([{ installKey: true }]);
    expect(askpass.authenticatedCalls).toBe(0);
    t.listen();
    await expect(opening).resolves.toBe(3000);
    expect(askpass.authenticatedCalls).toBe(1);
    t.forwards.release({ deviceId: 'd1', remotePort: 3000, holder: 'a' });
    for (const l of askpass.keyListeners) l({ status: 'failed', reason: 'not-accepted' });
    expect(reports).toEqual([['me@box', { status: 'failed', reason: 'not-accepted' }]]);
  });
});

// #6264「端口」页签(照 VS Code 的 Ports 视图):列出、停止、页签关掉时它拿着的全放手。
describe('端口表:列出、停止转发、页签走了全部放手', () => {
  async function ready(t: ReturnType<typeof setup>, remotePort: number, holder: string) {
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort, holder });
    await t.until(() => t.children.some((c) => c.args.includes(`127.0.0.1:${remotePort}:localhost:${remotePort}`)));
    t.listen();
    return opening;
  }

  it("lists this machine's forwards with who holds them, and maps a local port back to its remote port", async () => {
    const t = setup();
    await ready(t, 5173, 'tab-a');
    await ready(t, 8000, 'tab-a');
    await t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 8000, holder: 'manual' });
    expect(t.forwards.list('d1').map((f) => [f.remotePort, f.phase, f.holders])).toEqual([
      [5173, 'ready', ['tab-a']],
      [8000, 'ready', ['tab-a', 'manual']],
    ]);
    expect(t.forwards.list('other')).toEqual([]);
    expect(t.forwards.remoteForLocal('d1', 8000)).toBe(8000);
    expect(t.forwards.remoteForLocal('d1', 9999)).toBeNull();
  });

  it('stop tears it down no matter who holds it', async () => {
    const t = setup();
    await ready(t, 5173, 'tab-a');
    expect(t.forwards.stop('d1', 5173)).toBe(true);
    expect(t.children[0]!.killed).toBe(true);
    expect(t.links.at(-1)).toMatchObject({ remotePort: 5173, phase: 'closed' });
    expect(t.forwards.list('d1')).toEqual([]);
    expect(t.forwards.stop('d1', 5173)).toBe(false);
  });

  it('releaseHolder lets go of every port a closed tab held, but keeps ports others still use', async () => {
    const t = setup();
    await ready(t, 5173, 'tab-a');
    await ready(t, 8000, 'tab-a');
    await t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 8000, holder: 'tab-b' });
    t.forwards.releaseHolder('tab-a');
    expect(t.forwards.list('d1').map((f) => [f.remotePort, f.holders])).toEqual([[8000, ['tab-b']]]);
  });
});

describe('同号转发(登录回跳)', () => {
  it('这台电脑上同号被占:不换号、不起 ssh,报 local-port-busy', async () => {
    const t = setup({ busy: [1455] });
    await expect(
      t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 1455, holder: 'login:r', exactLocalPort: true })
    ).rejects.toMatchObject({ reason: 'local-port-busy' });
    expect(t.children).toHaveLength(0);
  });

  it('空着就同号转', async () => {
    const t = setup();
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 1455, holder: 'login:r', exactLocalPort: true });
    await t.until(() => t.children.length === 1);
    expect(t.children[0]!.args).toContain('127.0.0.1:1455:localhost:1455');
    t.listen();
    expect(await opening).toBe(1455);
  });
});

// #6264 一台机器一条认证过的连接(照 VS Code Remote-SSH):有复用连接时,端口转发骑在共享连接上 ——
// 先确保连接在(不在才认证、才问人),再 `ssh -O forward`;放手时 `-O cancel`,❌ 另开一条连接再认证一次。
describe('端口转发骑在共享连接上', () => {
  const mux = (local = 3000, remote = 3000) => ({
    ensureArgs: ['ensure', 'exit 0'],
    forwardArgs: ['-O', 'forward', '-L', `127.0.0.1:${local}:localhost:${remote}`],
    cancelArgs: ['-O', 'cancel', '-L', `127.0.0.1:${local}:localhost:${remote}`],
  });

  it('确保连接在 → -O forward → 本机端口能连上才算好;放手 = -O cancel', async () => {
    const t = setup({ spec: { mux: mux() } });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    expect(t.children[0]!.args).toEqual(['ensure', 'exit 0']);
    t.children[0]!.exit({ exitCode: 0 });
    await t.until(() => t.children.length === 2);
    expect(t.children[1]!.args.slice(0, 2)).toEqual(['-O', 'forward']);
    t.children[1]!.exit({ exitCode: 0 });
    t.listening.add(3000);
    await expect(opening).resolves.toBe(3000);
    expect(t.links.at(-1)).toMatchObject({ phase: 'ready', localPort: 3000 });
    t.forwards.release({ deviceId: 'd1', remotePort: 3000, holder: 'a' });
    expect(t.children.at(-1)!.args.slice(0, 2)).toEqual(['-O', 'cancel']);
  });

  it('要密码的那一步(确保连接在)照样经提问卡片问;答了才往下走;勾「下次免密」+ 登上 = 告诉 askpass', async () => {
    const askpass = fakeAskpass();
    const t = setup({ askpass, spec: { mux: mux() } });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    askpass.ask({ id: 'p1', kind: 'password', message: 'me@box password:', offerKeyInstall: true });
    expect(t.links.at(-1)).toMatchObject({ phase: 'connecting', prompt: { id: 'p1' } });
    t.forwards.answerPrompt({ deviceId: 'd1', remotePort: 3000, promptId: 'p1', value: 'pw', installKey: true });
    t.children[0]!.exit({ exitCode: 0 });
    await t.until(() => t.children.length === 2);
    expect(askpass.authenticatedCalls).toBe(1);
    expect(askpass.closed).toBe(true);
    t.children[1]!.exit({ exitCode: 0 });
    t.listening.add(3000);
    await expect(opening).resolves.toBe(3000);
  });

  it('共享连接断了(本机端口连不上了):持有者再要时重转,❌ 把一个死端口交出去', async () => {
    const t = setup({ spec: { mux: mux() } });
    const first = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    t.children[0]!.exit({ exitCode: 0 });
    await t.until(() => t.children.length === 2);
    t.children[1]!.exit({ exitCode: 0 });
    t.listening.add(3000);
    await first;
    // 还连得上:直接给,不起任何 ssh。
    await expect(t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'b' })).resolves.toBe(3000);
    expect(t.children).toHaveLength(2);
    t.listening.delete(3000);
    const again = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 3);
    expect(t.children[2]!.args).toEqual(['ensure', 'exit 0']);
    t.children[2]!.exit({ exitCode: 0 });
    await t.until(() => t.children.length === 4);
    t.children[3]!.exit({ exitCode: 0 });
    t.listening.add(3000);
    await expect(again).resolves.toBe(3000);
  });

  it('认证没过(确保连接那一步 255 + Permission denied):报 auth,❌ 去加转发', async () => {
    const t = setup({ spec: { mux: mux() } });
    const opening = t.forwards.open({ deviceId: 'd1', sessionId: 'c1', remotePort: 3000, holder: 'a' });
    await t.until(() => t.children.length === 1);
    t.children[0]!.stderr('me@box: Permission denied (publickey,password).\n');
    t.children[0]!.exit({ exitCode: 255 });
    await expect(opening).rejects.toMatchObject({ reason: 'auth' });
    expect(t.children).toHaveLength(1);
  });
});
