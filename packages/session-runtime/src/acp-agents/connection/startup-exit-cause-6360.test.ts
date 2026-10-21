import { errorDetail, isErr } from '@gugu/session-shared';
import { createScope } from '@gugu/session-wire/util';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, FakeAcpProcessHost } from '../acp-test-support';
import { createAcpAgentConnection } from './acp-agent-connection';

/**
 * #6360:适配器在 initialize 回话之前自己退了,失败原因只剩传输层的 `ACP connection closed` /
 * `write EPIPE` —— 真因(它的退出码、它最后打到 stderr 的那几行)被丢了。
 * 判据:启动失败的 cause 带着**进程自己的**退出码/信号与 stderr 尾巴,经 `errorDetail` 上屏;
 * 进程活着时不等它、不编一个退出码,如实标「咕咕停的」。
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function startWith(initialize: (host: FakeAcpProcessHost) => Promise<unknown>) {
  const agent = new FakeAcpAgent();
  const host = new FakeAcpProcessHost();
  agent.initialize = vi.fn(() => initialize(host));
  const result = await createAcpAgentConnection(
    {
      host,
      behavior: {
        buildSpawn: vi.fn().mockReturnValue({ command: '/fake/agent', args: [], env: {} }),
        connect: agent.behavior.connect,
      },
    },
    {
      connectionKey: 'copilot:ws-1',
      providerId: 'copilot',
      spawn: { command: '/fake/agent', args: [], env: {}, cwd: '/tmp/workspace' },
      scope: createScope({ label: 'test-startup-exit-6360' }),
      buildClient: vi.fn(),
      onClosed: vi.fn(),
    }
  );
  return { result, host };
}

function causeOf(result: Awaited<ReturnType<typeof startWith>>['result']) {
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) throw new Error('expected a failed start');
  expect(result.error.type).toBe('initialize_failed');
  const cause = 'cause' in result.error ? result.error.cause : undefined;
  if (!cause) throw new Error('initialize_failed carried no cause');
  return cause;
}

describe('startup failure carries the adapter process\'s own exit code and stderr tail (#6360)', () => {
  it('exits before answering initialize: reports its exit code and what it printed', async () => {
    const { result } = await startWith(async (host) => {
      const handle = host.lastHandle;
      handle.stderr.write('fail-stub-40c8: COPILOT_BROKEN_ENV=1 — cannot load config\n');
      await settle();
      handle.emitExit(3, null);
      handle.stderr.end();
      return new Promise(() => {}); // never answers
    });
    const cause = causeOf(result);
    expect(cause.data).toMatchObject({ exitCode: 3, stderrTail: expect.stringContaining('cannot load config') });
    expect(cause.data).not.toHaveProperty('stoppedByGugu');
    const shown = errorDetail(cause) ?? '';
    expect(shown).toContain('exitCode=3');
    expect(shown).toContain('fail-stub-40c8: COPILOT_BROKEN_ENV=1 — cannot load config');
  });

  it('transport reports "ACP connection closed" before the exit event: waits for the exit and reports its own code', async () => {
    const { result, host } = await startWith(async (host) => {
      const handle = host.lastHandle;
      handle.stderr.write('adapter: missing dependency libfoo\n');
      await settle();
      // The SDK's rejection lands first; the process's own close follows (see reducer.ts).
      setImmediate(() => { handle.emitExit(3, null); handle.stderr.end(); });
      throw new Error('ACP connection closed');
    });
    const cause = causeOf(result);
    expect(cause.message).toBe('ACP connection closed');
    expect(cause.data).toMatchObject({ exitCode: 3, stderrTail: 'adapter: missing dependency libfoo' });
    // Gugu's SIGTERM landed on a process already exiting by itself: the result is still its own exit 3.
    expect(cause.data).not.toHaveProperty('stoppedByGugu');
    expect(cause.data).not.toHaveProperty('signal');
    expect(host.lastHandle.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('EPIPE on write is a lost transport too', async () => {
    const { result } = await startWith(async (host) => {
      const handle = host.lastHandle;
      setImmediate(() => { handle.emitExit(1, null); handle.stderr.end(); });
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    const cause = causeOf(result);
    expect(cause.data).toMatchObject({ exitCode: 1 });
    expect(errorDetail(cause)).toContain('exitCode=1');
  });

  it('mac1 shape: stdin EPIPE surfaces as a process error first; exit code and stderr arrive after it', async () => {
    const { result } = await startWith(async (host) => {
      const handle = host.lastHandle;
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      // The process-error event lands first (settles processClosed with no exit code) …
      handle.emitError(epipe);
      // … then the adapter's own words and its exit.
      setImmediate(() => {
        handle.stderr.write('fail-stub-40c8: COPILOT_BROKEN_ENV=1 — cannot load config\n');
        setImmediate(() => { handle.emitExit(3, null); handle.stderr.end(); });
      });
      throw epipe;
    });
    const cause = causeOf(result);
    expect(cause.code).toBe('EPIPE');
    expect(cause.data).toMatchObject({ exitCode: 3, stderrTail: expect.stringContaining('cannot load config') });
    const shown = errorDetail(cause) ?? '';
    expect(shown).toContain('exitCode=3');
    expect(shown).toContain('fail-stub-40c8');
  });

  it('a grandchild holding stderr open does not block the failure: settles on the parent exit with what was read', async () => {
    const { result } = await startWith(async (host) => {
      const handle = host.lastHandle;
      handle.stderr.write('wrapper: spawned engine, config missing\n');
      await settle();
      // Parent exits; a grandchild inherited stderr and is still alive ⇒ the pipe never ends.
      setImmediate(() => handle.emitExit(3, null));
      throw new Error('ACP connection closed');
    });
    const cause = causeOf(result);
    expect(cause.data).toMatchObject({ exitCode: 3, stderrTail: 'wrapper: spawned engine, config missing' });
  });

  it('adapter answered with a JSON-RPC error while alive: stopped by Gugu, no invented exit code, no hang', async () => {
    const { result, host } = await startWith(async (host) => {
      host.lastHandle.stderr.write('adapter: unsupported protocol version\n');
      await settle();
      throw Object.assign(new Error('Internal error'), { code: -32603 });
    });
    const cause = causeOf(result);
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(cause.data).toMatchObject({
      stoppedByGugu: true,
      stderrTail: 'adapter: unsupported protocol version',
    });
    expect(cause.data).not.toHaveProperty('exitCode');
    expect(cause.code).toBe(-32603);
    expect(errorDetail(cause)).toContain('stoppedByGugu=true');
  });

  it('the stderr tail on the failure surface is redacted like the exit record', async () => {
    const { result } = await startWith(async (host) => {
      const handle = host.lastHandle;
      handle.stderr.write('auth failed: Authorization: Bearer abcdef1234567890TOKEN\n');
      await settle();
      handle.emitExit(2, null);
      handle.stderr.end();
      return new Promise(() => {});
    });
    const cause = causeOf(result);
    expect(String((cause.data as Record<string, unknown>).stderrTail)).not.toContain('abcdef1234567890TOKEN');
  });
});
