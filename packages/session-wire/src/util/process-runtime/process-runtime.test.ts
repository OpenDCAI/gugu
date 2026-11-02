import { describe, expect, it, vi } from 'vitest';
import type { Controller } from '../../api/controller';
import { defineContract } from '../../api/define';
import type { ManagedProcess, ProcessHost } from '../../process/types';
import { createStubLogger } from '../../testing';
import { createScope } from '../scope';
import { serveWorkerProcess, spawnRuntime, RUNTIME_SHUTDOWN_SIGNAL, type ProcessRuntimePort } from './process-runtime';

function workerPort(sendAndWait = vi.fn(async () => {})) {
  const messages = new Set<(message: unknown) => void>();
  const disconnects = new Set<() => void>();
  const port: ProcessRuntimePort = {
    send: vi.fn(), sendAndWait,
    onMessage(cb) { messages.add(cb); return () => messages.delete(cb); },
    onDisconnect(cb) { disconnects.add(cb); return () => disconnects.delete(cb); },
  };
  return { port, disconnect: () => { for (const cb of disconnects) cb(); },
    shutdown: () => { for (const cb of messages) cb(RUNTIME_SHUTDOWN_SIGNAL); } };
}

describe('worker parent ownership', () => {
  it('exits on parent disconnect without closing active sessions or reporting shutdown', async () => {
    const wire = workerPort();
    const dispose = vi.fn();
    const exit = vi.fn();
    const { logger, calls } = createStubLogger();
    await serveWorkerProcess(() => ({ dispose } as unknown as Controller), { port: wire.port, logger, exit });
    calls.length = 0;
    wire.disconnect();
    expect(exit).toHaveBeenCalledWith(0);
    expect(dispose).not.toHaveBeenCalled();
    expect(wire.port.sendAndWait).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    ['closed parent channel', Object.assign(new Error('closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }), 0],
    ['other shutdown error', new Error('fixture send failure'), 1],
  ])('handles %s with the corresponding exit', async (_label, failure, code) => {
    const wire = workerPort(vi.fn(async () => { throw failure; }));
    const dispose = vi.fn();
    const { logger, calls } = createStubLogger();
    let exited!: (value: number) => void;
    const whenExited = new Promise<number>(resolve => { exited = resolve; });
    await serveWorkerProcess(() => ({ dispose } as unknown as Controller), { port: wire.port, logger, exit: exited });
    wire.shutdown();
    expect(await whenExited).toBe(code);
    expect(dispose).toHaveBeenCalledOnce();
    expect(calls.some(call => call.level === 'error')).toBe(code === 1);
  });
});

describe('spawnRuntime', () => {
  it('rejects with the not-ready error, not the error of shutting the unready process down', async () => {
    const shutdownFailure = new Error('Graceful shutdown timed out after 1000ms');
    const neverReady: ManagedProcess = {
      pid: 1,
      send: () => {},
      onMessage: () => () => {},
      onExit: () => () => {},
      onStdio: () => () => {},
      onError: () => () => {},
      dispose: () => Promise.reject(shutdownFailure),
    };
    const host: ProcessHost = { spawn: async () => neverReady };
    const { logger, calls } = createStubLogger();

    const rejection = await spawnRuntime({
      host,
      scope: createScope({ logger }),
      contract: defineContract({}),
      spec: { entry: 'worker.js' },
      readyTimeoutMs: 1,
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Runtime did not become ready within 1ms');
    expect(calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'runtime cleanup after a failed start failed',
        fields: expect.objectContaining({ error: shutdownFailure }),
      })
    );
  });
});
