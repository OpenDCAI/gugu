import { describe, expect, it } from 'vitest';
import { defineContract } from '../../api/define';
import type { ManagedProcess, ProcessHost } from '../../process/types';
import { createStubLogger } from '../../testing';
import { createScope } from '../scope';
import { spawnRuntime } from './process-runtime';

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
