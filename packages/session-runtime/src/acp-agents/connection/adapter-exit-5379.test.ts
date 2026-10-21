import { isErr, isOk } from '@gugu/session-shared';
import type { LogFields } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, FakeAcpProcessHost } from '../acp-test-support';
import type { AdapterExit } from '@gugu/session-core/acp';
import { createAcpAgentConnection } from './acp-agent-connection';

/**
 * #5379:适配器意外退出从前**一行不记** —— 退出码、信号、它最后说的话全丢。
 * owner 那台 00:31:27 猝死后,三个仪器都只看得见后果,查不出原因。
 * 判据既要证明「记得下来」,也要证明「凭据不跟着进日志」。
 */
type Line = { level: string; message: string; fields?: LogFields };

function recordingLogger(lines: Line[]) {
  const push = (level: string) => (message: string, fields?: LogFields) => {
    lines.push({ level, message, fields });
  };
  const self = {
    level: 'debug' as const,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => self,
  };
  return self;
}

async function readyConnection() {
  const lines: Line[] = [];
  const agent = new FakeAcpAgent();
  const host = new FakeAcpProcessHost();
  const onClosed = vi.fn<(exit: AdapterExit) => void>();
  const result = await createAcpAgentConnection(
    {
      host,
      behavior: {
        buildSpawn: vi.fn().mockReturnValue({ command: '/fake/agent', args: [], env: {} }),
        connect: agent.behavior.connect,
      },
      logger: recordingLogger(lines),
    },
    {
      connectionKey: 'claude:ws-1',
      providerId: 'claude',
      spawn: { command: '/fake/agent', args: [], env: {}, cwd: '/tmp/workspace' },
      scope: createScope({ label: 'test-adapter-exit' }),
      buildClient: vi.fn(),
      onClosed,
    }
  );
  expect(isOk(result)).toBe(true);
  return { handle: host.lastHandle, onClosed, lines };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function exitLine(lines: Line[]): Line | undefined {
  return lines.find((line) => line.message.startsWith('session/acp-exit'));
}

describe("adapter exit reaps the adapter's process tree (#5405)", () => {
  it('reaps before reporting the close — the host settles quota on that report', async () => {
    const { handle, onClosed } = await readyConnection();
    const order: string[] = [];
    handle.reap.mockImplementation(async () => {
      order.push('reap');
      return { reaped: 2, pids: [4300, 4400] };
    });
    onClosed.mockImplementation(() => void order.push('onClosed'));

    // 阳控:退出之前一次都不该收 —— 否则「退出后收了」证明不了它是退出边收的。
    expect(handle.reap).not.toHaveBeenCalled();

    handle.emitExit(null, 'SIGKILL');
    await settle();
    await settle();

    // 这个顺序就是合同:onClosed 之后宿主撤令牌、删 0600 settings 文档,而一个还活着的引擎
    // 握着刚被撤销的凭据,下一次调用就是 401(#5405 真机实测)。
    expect(order).toEqual(['reap', 'onClosed']);
  });

  it('puts the reaped count on the exit record — 0 and "did not reap" are different facts', async () => {
    const { handle, lines } = await readyConnection();
    handle.reap.mockResolvedValue({ reaped: 2, pids: [4300, 4400] });

    handle.emitExit(null, 'SIGKILL');
    await settle();
    await settle();

    const exit = exitLine(lines);
    expect(exit?.fields?.reapedChildren).toBe(2);
    expect(exit?.fields?.reapedPids).toEqual([4300, 4400]);
    expect(exit?.fields?.reapError).toBeUndefined();
  });

  it('still reports the loss when the reap itself fails, and says so', async () => {
    // 收树失败不能吞掉这条通知:会话永远停在 ready 比一个孤儿更糟。
    const { handle, onClosed, lines } = await readyConnection();
    handle.reap.mockRejectedValue(new Error('ps unavailable'));

    handle.emitExit(null, 'SIGKILL');
    await settle();
    await settle();

    expect(onClosed).toHaveBeenCalledWith({ exitCode: null, signal: 'SIGKILL', stderrTail: '' });
    const exit = exitLine(lines);
    expect(exit?.fields?.reapedChildren).toBeNull();
    expect(exit?.fields?.reapError).toContain('ps unavailable');
  });
});

describe('adapter exit is recorded (#5379)', () => {
  it('logs connectionKey, exit code, signal and the stderr tail at error level', async () => {
    const { handle, onClosed, lines } = await readyConnection();

    handle.stderr.write('claude-agent-acp: session table corrupted\n');
    handle.stderr.write('at Object.fork (index.js:1)\n');
    await settle();
    // 阳控:退出之前**不该**有这条 error —— 否则「退出后有」证明不了它是退出记下来的。
    expect(exitLine(lines)).toBeUndefined();

    handle.emitExit(null, 'SIGTERM');
    await settle();

    const exit = exitLine(lines);
    expect(exit?.level).toBe('error');
    expect(exit?.fields?.connectionKey).toBe('claude:ws-1');
    expect(exit?.fields?.exitCode).toBeNull();
    // 少了 signal 这一维,SIGTERM 与「正常退出但没给码」在日志里一模一样。
    expect(exit?.fields?.signal).toBe('SIGTERM');
    expect(String(exit?.fields?.stderrTail)).toContain('session table corrupted');
    expect(exit?.fields?.stderrTailLines).toBe(2);
    expect(onClosed).toHaveBeenCalledWith({
      exitCode: null,
      signal: 'SIGTERM',
      // #5858:stderr 的尾巴现在**也进结算** —— 它此前只到日志为止,而收尾行说不出引擎最后说了什么。
      stderrTail: 'claude-agent-acp: session table corrupted\nat Object.fork (index.js:1)',
    });
  });

  it('redacts credentials the adapter printed before dying', async () => {
    const { handle, lines } = await readyConnection();

    handle.stderr.write('auth failed: Authorization: Bearer abcdef1234567890TOKEN\n');
    handle.stderr.write('using api_key=sk-live-01234567890abcdef\n'); // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
    await settle();
    handle.emitExit(1, null);
    await settle();

    const tail = String(exitLine(lines)?.fields?.stderrTail);
    // 阳控:尾巴确实带上了那两行(否则「没有明文」只说明它什么都没记)。
    expect(tail).toContain('auth failed');
    expect(tail).toContain('using api_key');
    expect(tail).not.toContain('abcdef1234567890TOKEN');
    expect(tail).not.toContain('sk-live-01234567890abcdef');
    expect(tail).toContain('<redacted>');
  });

  /**
   * #5391:上一条只钉了 `sk-` / `Bearer` / `api_key=` 三种形态,而 stderr 是第三方 adapter 的
   * 自由文本 —— 网关和 SDK 报错时最常见的写法是把整条 URL 打出来,凭据就坐在 query 里
   * (`?token=…` / `&key=…`),名字里既没有 `api` 也没有 `access`,上一版一个都拦不住。
   * 登录邮箱同理:它不是凭据,但这些日志会被贴进 issue 与证据包。
   */
  it('redacts credentials sitting in a URL query, and the login email, without eating ordinary stderr', async () => {
    const { handle, lines } = await readyConnection();

    handle.stderr.write(
      'GET https://gw.example.com/v1/models?token=0123456789abcdef&key=fedcba9876543210 -> 401\n' // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
    );
    handle.stderr.write('login rejected for owner@example.com\n');
    // 阴控:一条不含凭据的普通 stderr —— 它必须**逐字**活下来。
    // 少了这一条,「明文不在尾巴里」也可以由「脱敏把整行都吃了」满足,判据就判不了假。
    handle.stderr.write('ECONNREFUSED 127.0.0.1:7890 while dialing /v1/chat/completions\n');
    await settle();
    handle.emitExit(1, null);
    await settle();

    const tail = String(exitLine(lines)?.fields?.stderrTail);
    // 阳控:那三行确实进了尾巴(否则下面的 not.toContain 只说明它什么都没记)。
    expect(tail).toContain('GET https://gw.example.com/v1/models');
    expect(tail).toContain('login rejected for');
    expect(tail.split('\n')).toHaveLength(3);

    expect(tail).not.toContain('0123456789abcdef');
    expect(tail).not.toContain('fedcba9876543210');
    expect(tail).not.toContain('owner@example.com');
    // 域名留下 —— 它说明「哪个租户」,不说明「是谁」,而它对定位错网关有用。
    expect(tail).toContain('<redacted>@example.com');
    expect(tail).toContain('ECONNREFUSED 127.0.0.1:7890 while dialing /v1/chat/completions');
  });
});

// #6183(原在 acp-agent-connection.test.ts,那个文件被 #6177 删掉;本 PR 的第 ③ 条语义挪到这里守):
// initialize 只等事实(回话 / 退出),没有时钟。慢的适配器被等到;永不回话的只在属主 dispose 时结束。
describe('initialize waits for facts, not a clock (#6183)', () => {
  function initializing(agent: FakeAcpAgent) {
    const host = new FakeAcpProcessHost();
    const scope = createScope({ label: 'test-initialize-6183' });
    const pending = createAcpAgentConnection(
      {
        host,
        behavior: {
          buildSpawn: vi.fn().mockReturnValue({ command: '/fake/agent', args: [], env: {} }),
          connect: agent.behavior.connect,
        },
      },
      {
        connectionKey: 'claude:ws-1',
        providerId: 'claude',
        spawn: { command: '/fake/agent', args: [], env: {}, cwd: '/tmp/workspace' },
        scope,
        buildClient: vi.fn(),
        onClosed: vi.fn(),
      }
    );
    return { host, scope, pending };
  }

  it('waits for a slow initialize instead of timing it out', async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAcpAgent();
      let respond!: () => void;
      agent.initialize = vi.fn(
        () => new Promise((resolve) => {
          respond = () => resolve({ protocolVersion: 1, agentCapabilities: {} });
        }),
      ) as never;
      const { host, pending } = initializing(agent);
      await agent.called('initialize');
      // 远超旧的 10s 预算:慢不是失败。
      await vi.advanceTimersByTimeAsync(120_000);
      expect(host.lastHandle.kill).not.toHaveBeenCalled();
      respond();
      expect(isOk(await pending)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a never-initializing adapter only when its owner disposes the scope', async () => {
    const agent = new FakeAcpAgent();
    agent.initialize = vi.fn(() => new Promise(() => {})) as never;
    const { host, scope, pending } = initializing(agent);
    await agent.called('initialize');
    host.lastHandle.kill.mockImplementation(() => host.lastHandle.emitExit(null, 'SIGTERM'));

    await scope.dispose();
    const result = await pending;

    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.type).toBe('initialize_failed');
    expect(result.error.cause?.message).toContain('exited before initialize completed');
    expect(result.error.cause?.message).toContain('signal SIGTERM');
  });
});
