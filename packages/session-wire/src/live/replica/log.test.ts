import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract, liveLog } from '../../api/define';
import { createTestWire, deferred } from '../../testing';
import { LiveLog } from '../log';
import { createLiveLogReplica } from './log';

const api = defineContract({
  output: liveLog({ key: z.object({ id: z.string() }) }),
});

describe('createLiveLogReplica', () => {
  it('seeds retained text and passes through appends under local cursors', async () => {
    const key = { id: 'session' };
    const log = new LiveLog({ generation: 1000 });
    log.append('seed\n');
    const contractClient = createTestWire(api, { output: () => log }).client;

    const replica = createLiveLogReplica(api.output, contractClient.output);
    const lease = replica.acquire(key);
    const output = await lease.ready();
    const appends: string[] = [];
    const appended = deferred();
    output.onAppend((chunk) => {
      appends.push(chunk);
      appended.resolve();
    });

    expect(output.text()).toBe('seed\n');
    log.append('next\n');
    await appended.promise;

    expect(appends).toEqual(['next\n']);
    expect((await output.snapshot()).data.text).toBe('seed\nnext\n');

    await lease.release();
    await replica.dispose();
  });

  it('writes through to a custom log store', async () => {
    const key = { id: 'session' };
    const log = new LiveLog({ generation: 1000 });
    log.append('seed');
    const contractClient = createTestWire(api, { output: () => log }).client;
    let text = '';
    const appended = deferred();

    const replica = createLiveLogReplica(api.output, contractClient.output, {
      store: () => ({
        reset: (data) => {
          text = data.text;
        },
        append: (chunk) => {
          text += chunk;
          appended.resolve();
        },
        text: () => text,
      }),
    });
    const lease = replica.acquire(key);
    const output = await lease.ready();

    expect(output.text()).toBe('seed');
    log.append('\nnext');
    await appended.promise;
    expect(output.text()).toBe('seed\nnext');

    await lease.release();
    await replica.dispose();
  });

  it('supports write-only log sinks without readable text', async () => {
    const key = { id: 'session' };
    const log = new LiveLog({ generation: 1000 });
    log.append('seed');
    const contractClient = createTestWire(api, { output: () => log }).client;
    const writes: string[] = [];
    const appended = deferred();

    const replica = createLiveLogReplica(api.output, contractClient.output, {
      store: () => ({
        reset: (data) => {
          writes.push(`reset:${data.text}`);
        },
        append: (chunk) => {
          writes.push(`append:${chunk}`);
          appended.resolve();
        },
      }),
    });
    const lease = replica.acquire(key);
    const output = await lease.ready();

    expect(() => output.text()).toThrow('write-only LogSink');
    log.append('\nnext');
    await appended.promise;
    expect(writes).toEqual(['reset:seed', 'append:\nnext']);

    await lease.release();
    await replica.dispose();
  });

  it('serves downstream clients from the local log buffer', async () => {
    const key = { id: 'session' };
    const log = new LiveLog({ generation: 1000 });
    const upstream = createTestWire(api, { output: () => log }).client;
    const replica = createLiveLogReplica(api.output, upstream.output);
    const downstream = createTestWire(api, { output: replica }).client;

    const handle = downstream.output.handle(key);
    const updates: string[] = [];
    const delivered = deferred();
    const detach = await handle.attach((update) => {
      updates.push((update.delta as { chunk: string }).chunk);
      delivered.resolve();
    });
    await handle.snapshot();
    log.append('served\n');
    await delivered.promise;

    expect((await handle.snapshot()).data.text).toBe('served\n');

    detach();
    await replica.dispose();
  });
});
