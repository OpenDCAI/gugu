import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/parent-disconnect.ts', import.meta.url));

async function run(disconnect: boolean, mode: 'early' | 'late' | 'backlog' = 'early') {
  const child = fork(fixture, [mode], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(child, 'exit');
  const stderrClosed = once(child.stderr!, 'close');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child, 'message'),
      exited.then(() => { throw new Error(`Logging fixture exited before ready: ${stderr}`); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Logging fixture did not become ready')), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (mode === 'backlog') {
      child.stderr!.pause();
      const queued = once(child, 'message');
      child.send('queue');
      const [message] = await Promise.race([
        queued,
        exited.then(() => { throw new Error('Logging fixture exited before queueing warnings'); }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Logging fixture did not queue warnings')), 10_000);
        }),
      ]);
      clearTimeout(timer);
      expect(message).toBe('queued');
    }
    if (disconnect) {
      child.stderr!.destroy();
      child.disconnect();
    } else {
      child.send('finish');
    }
    const [result] = await Promise.race([
      Promise.all([exited, stderrClosed]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Logging fixture hung while exiting (code=${child.exitCode}, signal=${child.signalCode})`)), 5_000);
      }),
    ]);
    return { code: result[0], signal: result[1], stderr };
  } finally {
    clearTimeout(timer);
    await stopFixture(child, exited);
  }
}

async function stopFixture(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await exited;
}

describe('process logging on parent disconnect', () => {
  it('keeps shutdown warnings readable while the parent is connected', async () => {
    const result = await run(false);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('first shutdown warning');
    expect(result.stderr).toContain('second shutdown warning');
  }, 20_000);

  it('exits after IPC and the stderr reader close with queued shutdown warnings', async () => {
    const result = await run(true);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  }, 20_000);

  it('exits if the parent disconnected before logging was initialized', async () => {
    const result = await run(true, 'late');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  }, 20_000);

  it('exits with warnings already backlogged before the parent disconnects', async () => {
    const result = await run(true, 'backlog');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  }, 20_000);
});
