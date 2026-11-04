import type { ChildProcess } from 'node:child_process';
import { fork } from '@gugu/core/local/childProcess';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineContract } from '../../api/define';
import { createStubLogger } from '../../testing';
import { killAllWorkersSync, spawnWorker } from '../../worker';
import { createScope } from '../scope';

describe('forked workers follow their host', () => {
  let dir: string;
  let entry: string;
  const children = new Set<ChildProcess>();
  afterEach(async () => {
    await Promise.all([...children].map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      children.delete(child);
    }));
  });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-worker-parent-'));
    entry = join(dir, 'worker.cjs');
    await build({
      stdin: {
        contents: `
          import { writeFileSync } from 'node:fs';
          import { initProcessLogging } from ${JSON.stringify(resolve('packages/session-shared/src/logger/node/index.ts'))};
          import { serveWorkerProcess } from ${JSON.stringify(resolve('packages/session-wire/src/util/process-runtime/process-runtime.ts'))};
          import { createController } from ${JSON.stringify(resolve('packages/session-wire/src/api/controller.ts'))};
          import { defineContract } from ${JSON.stringify(resolve('packages/session-wire/src/api/define.ts'))};
          const logger = initProcessLogging({ name: 'fixture-worker' });
          logger.info('fixture logging ready');
          process.on('disconnect', () => logger.error('parent disappeared'));
          void serveWorkerProcess(() => {
            const controller = createController(defineContract({}), {});
            return { ...controller, dispose() {
              writeFileSync(process.env.DISPOSE_MARKER, 'disposed');
              controller.dispose();
            } };
          }, { logger });
        `,
        resolveDir: process.cwd(),
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: entry,
    });
  });
  afterAll(() => {
    if (!dir?.startsWith(join(tmpdir(), 'gugu-worker-parent-'))) throw new Error('unexpected fixture directory');
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits after IPC and the stderr reader disappear, without disposing active sessions', async () => {
    const marker = join(dir, 'disposed');
    const child: ChildProcess = fork(entry, [], { silent: true, execArgv: [], env: { ...process.env, DISPOSE_MARKER: marker } });
    children.add(child);
    try {
      await once(child, 'message');
      child.stderr!.destroy();
      const exited = once(child, 'exit');
      child.disconnect();
      expect(await exited).toEqual([0, null]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 1_000);

  it('reaps every registered worker synchronously rather than closing their sessions', async () => {
    const { logger } = createStubLogger();
    const workers = await Promise.all(['acp', 'agent-config', 'fs-watch'].map(name => spawnWorker({
      name, entry, contract: defineContract({}), scope: createScope({ logger }),
      supervision: { restart: 'never' }, env: { DISPOSE_MARKER: join(dir, `disposed-${name}`) },
    })));
    try {
      killAllWorkersSync();
      expect(await Promise.all(workers.map(worker => worker.whenExited))).toEqual(
        workers.map(() => ({ code: null, signal: 'SIGKILL' })),
      );
      for (const name of ['acp', 'agent-config', 'fs-watch']) expect(existsSync(join(dir, `disposed-${name}`))).toBe(false);
    } finally {
      for (const worker of workers) {
        const pid = worker.process.pid;
        if (pid !== undefined) process.kill(pid, 'SIGKILL');
        await worker.dispose();
      }
    }
  });
});
