import { ok } from '@gugu/session-shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract, liveJob } from '../../api/define';
import { createTestWire, deferred } from '../../testing';
import { type LiveJobContext } from '../job';
import { createLiveJobReplica, type ReplicaJobState } from './job';
import { createPlainStore } from './store';

const api = defineContract({
  build: liveJob({
    input: z.object({ name: z.string() }),
    progress: z.object({ step: z.string() }),
    result: z.object({ artifact: z.string() }),
    error: z.object({ message: z.string() }),
  }),
});

type BuildInput = { name: string };
type BuildProgress = { step: string };
type BuildResult = { artifact: string };

describe('createLiveJobReplica', () => {
  it('starts jobs and retains terminal state for later acquire calls', async () => {
    const gate = deferred<void>();
    const { contractClient } = setup(async (input, ctx) => {
      await gate.promise;
      ctx.progress({ step: 'compile' });
      return { artifact: `${input.name}.zip` };
    });
    const jobs = createLiveJobReplica(api.build, contractClient.build, { retentionMs: 100 });
    const lease = await jobs.start({ name: 'desktop' });
    const running = await lease.ready();
    const progress: BuildProgress[] = [];
    const progressed = deferred();
    running.onProgress((entry) => {
      progress.push(entry);
      progressed.resolve();
    });

    gate.resolve();
    await progressed.promise;
    await expect(running.result).resolves.toEqual({ artifact: 'desktop.zip' });
    await lease.release();

    const retainedLease = jobs.acquire(running.jobId);
    const retained = await retainedLease.ready();
    expect(retained.getState()).toMatchObject({
      status: 'succeeded',
      result: { artifact: 'desktop.zip' },
    });

    await retainedLease.release();
    await jobs.dispose();
  });

  it('writes job state through to a custom store', async () => {
    const { contractClient } = setup(async (input, ctx) => {
      ctx.progress({ step: 'compile' });
      return { artifact: `${input.name}.zip` };
    });
    const stores: Array<ReturnType<typeof createPlainStore<ReplicaJobState<typeof api.build>>>> =
      [];
    // 副本把终态写进 store 的那一刻(reset)就是要等的事实;是哪个终态交给下面的断言。
    const settled = deferred();
    const jobs = createLiveJobReplica(api.build, contractClient.build, {
      store: () => {
        const store = createPlainStore<ReplicaJobState<typeof api.build>>();
        stores.push(store);
        return {
          ...store,
          reset(data) {
            store.reset(data);
            if (data.status !== 'running') settled.resolve();
          },
        };
      },
    });
    const lease = await jobs.start({ name: 'stored' });
    const running = await lease.ready();

    await settled.promise;
    expect(running.getState()?.status).toBe('succeeded');
    expect(stores[0]?.current()).toMatchObject({
      status: 'succeeded',
      result: { artifact: 'stored.zip' },
    });

    await lease.release();
    await jobs.dispose();
  });

  it('serves job state through createController from the local replica', async () => {
    const { contractClient } = setup(async (input) => ({ artifact: `${input.name}.zip` }));
    const jobs = createLiveJobReplica(api.build, contractClient.build);
    const downstream = createTestWire(api, { build: jobs }).client;

    const started = await downstream.build.start({ name: 'served' });
    const handle = downstream.build.handle(started.jobId);

    // 本地副本每变一次都会推一条更新给下游;每来一条就重读一次快照,读到终态为止。
    let changed = deferred();
    const detach = await handle.attach(() => changed.resolve());
    while ((await handle.snapshot()).data.status === 'running') {
      await changed.promise;
      changed = deferred();
    }
    detach();
    expect((await handle.snapshot()).data).toMatchObject({
      status: 'succeeded',
      result: { artifact: 'served.zip' },
    });

    await jobs.dispose();
  });
});

function setup(
  run: (input: BuildInput, ctx: LiveJobContext<BuildProgress>) => Promise<BuildResult> | BuildResult
) {
  const wire = createTestWire(api, {
    build: {
      run: async (input, ctx) => ok(await run(input as BuildInput, ctx)),
      toError: (error) => ({
        message: error instanceof Error ? error.message : String(error),
      }),
    },
  });
  return { contractClient: wire.client };
}
