import { describe, expect, it, vi } from 'vitest';
import { CLI_PREPARE_LINK_BUDGET_MS, CLI_PREPARE_REQUEST_TIMEOUT_MS, prepareThenStartCliLogin, type CliToolPrepareResult } from './cli-tool-prepare';

const started = { success: true as const, prompt: { kind: 'link' as const, url: 'https://login.test', code: 'ABCD' } };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('prepareThenStartCliLogin', () => {
  it.each(['server_outdated', 'client_outdated', 'forbidden', 'unauthorized'])('does not retry a terminal %s refusal', async code => {
    const failure = Object.assign(new Error('Rejected by the host'), { code });
    const api = { cliToolPrepare: vi.fn(async () => { throw failure; }), cliLoginStart: vi.fn() };
    await expect(prepareThenStartCliLogin(api, 'feishu')).rejects.toBe(failure);
    expect(api.cliToolPrepare).toHaveBeenCalledOnce();
    expect(api.cliLoginStart).not.toHaveBeenCalled();
  });

  it('bounds an unanswered request and never starts a login from its late response', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (result: CliToolPrepareResult) => void;
      const api = { cliToolPrepare: vi.fn(() => new Promise<CliToolPrepareResult>(resolve => { answer = resolve; })), cliLoginStart: vi.fn() };
      const run = prepareThenStartCliLogin(api, 'feishu');
      const rejected = expect(run).rejects.toMatchObject({ code: 'connection_prepare_timeout' });
      await vi.advanceTimersByTimeAsync(CLI_PREPARE_REQUEST_TIMEOUT_MS);
      await rejected;
      answer({ status: 'ready' });
      await Promise.resolve();
      expect(api.cliToolPrepare).toHaveBeenCalledOnce();
      expect(api.cliLoginStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('allows a cold wake and handshake to exceed the link retry budget', async () => {
    vi.useFakeTimers();
    try {
      const api = {
        cliToolPrepare: vi.fn(() => new Promise<CliToolPrepareResult>(resolve => setTimeout(() => resolve({ status: 'ready' }), 170_000))),
        cliLoginStart: vi.fn(async () => started),
      };
      const run = prepareThenStartCliLogin(api, 'feishu');
      await vi.advanceTimersByTimeAsync(100_000);
      expect(api.cliLoginStart).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(70_000);
      await expect(run).resolves.toBe(started);
      expect(api.cliToolPrepare).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('settles cancellation while the preparation call is still unanswered', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      let signal: AbortSignal | undefined;
      const api = { cliToolPrepare: vi.fn((_id: string, abort?: AbortSignal) => { signal = abort; return new Promise<CliToolPrepareResult>(() => {}); }), cliLoginStart: vi.fn() };
      const run = prepareThenStartCliLogin(api, 'feishu', { cancelled: () => cancelled });
      cancelled = true;
      await vi.advanceTimersByTimeAsync(100);
      await expect(run).resolves.toBeNull();
      expect(signal?.aborted).toBe(true);
      expect(api.cliLoginStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('asks until the tool is installed, then starts the login once', async () => {
    const answers: CliToolPrepareResult[] = [{ status: 'installing' }, { status: 'installing' }, { status: 'ready' }];
    const api = { cliToolPrepare: vi.fn(async () => answers.shift()!), cliLoginStart: vi.fn(async () => started) };
    await expect(prepareThenStartCliLogin(api, 'feishu', clock())).resolves.toBe(started);
    expect(api.cliToolPrepare).toHaveBeenCalledTimes(3);
    expect(api.cliLoginStart).toHaveBeenCalledTimes(1);
  });

  // 2026-10-28 owner 在 Beta 上:飞书在云电脑上装十来分钟,中途链路断一次,整次连接就报「此刻连不上」。
  it('rides out a dropped link while the tool keeps installing on the other machine', async () => {
    const lost = Object.assign(new Error('此刻连不上「咕咕」。'), { code: 'unreachable' });
    const answers: Array<CliToolPrepareResult | Error> = [{ status: 'installing' }, lost, lost, lost, { status: 'installing' }, { status: 'ready' }];
    const api = {
      cliToolPrepare: vi.fn(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; }),
      cliLoginStart: vi.fn(async () => started),
    };
    await expect(prepareThenStartCliLogin(api, 'feishu', clock())).resolves.toBe(started);
    expect(api.cliLoginStart).toHaveBeenCalledTimes(1);
  });

  it('gives up with the link error only after no answer for the whole budget', async () => {
    const lost = Object.assign(new Error('此刻连不上「咕咕」。'), { code: 'unreachable' });
    const time = clock();
    const api = { cliToolPrepare: vi.fn(async () => { throw lost; }), cliLoginStart: vi.fn(async () => started) };
    await expect(prepareThenStartCliLogin(api, 'feishu', time)).rejects.toBe(lost);
    expect(time.now()).toBeGreaterThanOrEqual(CLI_PREPARE_LINK_BUDGET_MS);
    expect(api.cliLoginStart).not.toHaveBeenCalled();
  });

  it('reports an install failure as the connection result, without starting a login', async () => {
    const api = { cliToolPrepare: vi.fn(async (): Promise<CliToolPrepareResult> => ({ status: 'failed', error: 'Download of x stalled' })), cliLoginStart: vi.fn() };
    await expect(prepareThenStartCliLogin(api, 'feishu', clock())).resolves.toEqual({ success: false, error: 'Download of x stalled' });
    expect(api.cliLoginStart).not.toHaveBeenCalled();
  });

  it('falls back to starting the login directly on a machine too old to know the question', async () => {
    const api = {
      cliToolPrepare: vi.fn(async () => { throw Object.assign(new Error('unknown method'), { code: 'unknown_method' }); }),
      cliLoginStart: vi.fn(async () => started),
    };
    await expect(prepareThenStartCliLogin(api, 'feishu', clock())).resolves.toBe(started);
  });

  it('does not start a login after the attempt was cancelled', async () => {
    let cancelled = false;
    const api = {
      cliToolPrepare: vi.fn(async (): Promise<CliToolPrepareResult> => { cancelled = true; return { status: 'ready' }; }),
      cliLoginStart: vi.fn(),
    };
    await expect(prepareThenStartCliLogin(api, 'feishu', { ...clock(), cancelled: () => cancelled })).resolves.toBeNull();
    expect(api.cliLoginStart).not.toHaveBeenCalled();
  });
});
