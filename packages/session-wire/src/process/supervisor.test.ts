import { Emitter, type Unsubscribe } from '@gugu/session-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope } from '../util';
import { createSupervisedProcess } from './supervisor';
import type { ChildHandle, ProcessExit, ProcessSpec, StdioStream } from './types';

describe('createSupervisedProcess', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts failed children with backoff and keeps one managed handle', async () => {
    vi.useFakeTimers();
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess(
      {
        entry: 'worker',
        supervision: { restart: 'on-failure', backoffMs: [25], maxRestarts: 1 },
      },
      spawnChild
    );
    const exits: Array<{ code: number | null; willRestart: boolean }> = [];
    process.onExit((exit) => exits.push(exit));

    children[0].exit({ code: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([{ code: 1, willRestart: true }]);
    process.send({ kind: 'ping' });
    expect(children[1].messages).toEqual([{ kind: 'ping' }]);
    expect(process.pid).toBe(children[1].pid);
  });

  it('does not restart clean exits or failures after maxRestarts', async () => {
    vi.useFakeTimers();
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess(
      {
        entry: 'worker',
        supervision: { restart: 'on-failure', backoffMs: [0], maxRestarts: 1 },
      },
      spawnChild
    );
    const exits: Array<{ code: number | null; willRestart: boolean }> = [];
    process.onExit((exit) => exits.push(exit));

    children[0].exit({ code: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    children[1].exit({ code: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([
      { code: 1, willRestart: true },
      { code: 1, willRestart: false },
    ]);

    const clean = await createSupervisedProcess(
      {
        entry: 'clean-worker',
        supervision: { restart: 'on-failure', backoffMs: [0], maxRestarts: 1 },
      },
      spawnChild
    );
    children[2].exit({ code: 0 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(clean.pid).toBeUndefined();
    expect(spawnChild).toHaveBeenCalledTimes(3);
  });

  it('suppresses restarts and kills the child when disposed through a scope', async () => {
    vi.useFakeTimers();
    const parent = createScope();
    const { children, spawnChild } = fakeSpawner();
    await createSupervisedProcess(
      {
        entry: 'worker',
        supervision: { restart: 'on-failure', backoffMs: [0], maxRestarts: 1 },
      },
      spawnChild,
      parent
    );

    await parent.dispose();
    children[0].exit({ code: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(children[0].killed).toBe(true);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });

  it('fails loud when graceful shutdown reaches its deadline before the child exits', async () => {
    vi.useFakeTimers();
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess(
      {
        entry: 'worker',
        gracefulShutdown: { message: { kind: 'shutdown' }, graceMs: 50 },
      },
      spawnChild
    );

    const dispose = process.dispose();
    expect(children[0].messages).toEqual([{ kind: 'shutdown' }]);
    expect(children[0].killed).toBe(false);

    const rejected = expect(dispose).rejects.toThrow('Graceful shutdown timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(children[0].killed).toBe(true);
  });

  it('resolves graceful shutdown only after the child reports a clean exit', async () => {
    vi.useFakeTimers();
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess(
      {
        entry: 'worker',
        gracefulShutdown: { message: { kind: 'shutdown' }, graceMs: 50 },
      },
      spawnChild
    );
    let releaseComplete = false;

    const dispose = process.dispose();
    releaseComplete = true;
    children[0].exit({ code: 0 });
    await dispose;

    expect(releaseComplete).toBe(true);
    expect(children[0].killed).toBe(false);
  });

  it('rejects graceful shutdown when the child reports cleanup failure', async () => {
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess(
      {
        entry: 'worker',
        gracefulShutdown: { message: { kind: 'shutdown' }, graceMs: 50 },
      },
      spawnChild
    );

    const dispose = process.dispose();
    children[0].exit({ code: 1 });

    await expect(dispose).rejects.toThrow('Graceful shutdown failed');
  });

  it('forwards messages and stdio from the current child', async () => {
    const { children, spawnChild } = fakeSpawner();
    const process = await createSupervisedProcess({ entry: 'worker' }, spawnChild);
    const messages: unknown[] = [];
    const stdio: Array<{ stream: StdioStream; chunk: string }> = [];
    process.onMessage((message) => messages.push(message));
    process.onStdio((stream, chunk) => stdio.push({ stream, chunk }));

    children[0].message({ kind: 'hello' });
    children[0].stdio('stdout', 'out');
    children[0].stdio('stderr', 'err');

    expect(messages).toEqual([{ kind: 'hello' }]);
    expect(stdio).toEqual([
      { stream: 'stdout', chunk: 'out' },
      { stream: 'stderr', chunk: 'err' },
    ]);
  });
});

function fakeSpawner() {
  let nextPid = 1;
  const children: FakeChild[] = [];
  const spawnChild = vi.fn((_spec: ProcessSpec) => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  });
  return { children, spawnChild };
}

class FakeChild implements ChildHandle {
  readonly messages: unknown[] = [];
  killed = false;
  private readonly messageEmitter = new Emitter<unknown>();
  private readonly exitEmitter = new Emitter<ProcessExit>();
  private readonly stdioEmitter = new Emitter<{ stream: StdioStream; chunk: string }>();
  private readonly errorEmitter = new Emitter<Error>();

  constructor(readonly pid: number) {}

  send(message: unknown): void {
    this.messages.push(message);
  }

  onMessage(cb: (message: unknown) => void): Unsubscribe {
    return this.messageEmitter.subscribe(cb);
  }

  onExit(cb: (exit: ProcessExit) => void): Unsubscribe {
    return this.exitEmitter.subscribe(cb);
  }

  onStdio(cb: (stream: StdioStream, chunk: string) => void): Unsubscribe {
    return this.stdioEmitter.subscribe(({ stream, chunk }) => cb(stream, chunk));
  }

  onError(cb: (error: Error) => void): Unsubscribe {
    return this.errorEmitter.subscribe(cb);
  }

  kill(): void {
    this.killed = true;
  }

  message(message: unknown): void {
    this.messageEmitter.emit(message);
  }

  exit(exit: ProcessExit): void {
    this.exitEmitter.emit(exit);
  }

  stdio(stream: StdioStream, chunk: string): void {
    this.stdioEmitter.emit({ stream, chunk });
  }
}
