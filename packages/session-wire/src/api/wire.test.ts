import { err, ok, type Unsubscribe } from '@gugu/session-shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLiveModelHost } from '../live/mutations';
import type { LiveSource, LiveUpdate } from '../live/protocol';
import { ReplicaState } from '../live/replica';
import { createTestWire, deferred } from '../testing';
import { client } from './client';
import { connect } from './connect';
import { createController, encodeTopic } from './controller';
import { forwardController } from './forward';
import { defineContract, liveModel, liveState, fallible, procedure } from './define';
import { isWireError, WireError, type WireMessage, type WireTransport } from './protocol';
import { serve } from './serve';
import { memoryTransportPair, reconnectingTransport } from './transports';

const contract = defineContract({
  greet: procedure({ input: z.object({ name: z.string() }), output: z.string() }),
  fail: procedure({ input: z.void().optional(), output: z.void() }),
  state: liveModel({
    key: z.object({ id: z.string() }),
    states: { state: liveState({ data: z.object({ count: z.number() }) }) },
  }),
});

function setup() {
  const host = createLiveModelHost(contract.state);
  const instance = host.create({ id: 'known' }, { state: { count: 0 } });
  const model = instance.states.state;
  const wire = createTestWire(contract, {
    greet: ({ name }) => `hello ${name}`,
    fail: () => {
      throw new WireError('NOT_FOUND', 'expected failure');
    },
    state: host,
  });
  return { pair: wire.pair, connection: wire.connection, model };
}

describe('wire serve/connect', () => {
  it('calls procedures and propagates errors', async () => {
    const { connection } = setup();
    await expect(connection.call('greet', { name: 'wire' })).resolves.toBe('hello wire');
    await expect(connection.call('fail', undefined)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('round-trips uncaught handler errors as HANDLER_ERROR with a serialized cause', async () => {
    const failingContract = defineContract({
      fail: procedure({ input: z.void().optional(), output: z.void() }),
    });
    const { connection } = createTestWire(failingContract, {
      fail: () => {
        throw new TypeError('boom');
      },
    });

    await expect(connection.call('fail', undefined)).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
      message: 'boom',
      cause: {
        name: 'TypeError',
        message: 'boom',
      },
    });
  });

  it('attaches invocation context to a rejected wire call', async () => {
    const failingContract = defineContract({
      fail: procedure({
        input: z.object({ sessionId: z.string(), providerSessionId: z.string() }),
        output: z.void(),
      }),
    });
    const { connection } = createTestWire(failingContract, {
      fail: () => {
        throw new WireError('HANDLER_ERROR', 'provider request failed');
      },
    });

    await expect(
      connection.call('fail', { sessionId: 'conversation-42', providerSessionId: 'session-42' }),
    ).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
      message: 'provider request failed',
      context: {
        callId: expect.any(String),
        path: 'fail',
        sessionId: 'conversation-42',
        providerSessionId: 'session-42',
      },
    });
  });

  it('preserves upstream message and structured status when a wire error has no local message', async () => {
    const failingContract = defineContract({
      fail: procedure({
        input: z.object({ agentUserId: z.string() }),
        output: z.void(),
      }),
    });
    const { connection } = createTestWire(failingContract, {
      fail: () => {
        const upstream = Object.assign(new Error('upstream quota exhausted'), {
          code: 'UPSTREAM_RATE_LIMIT',
          status: 429,
          response: { retryable: false, provider: 'codex' },
        });
        throw new WireError('HANDLER_ERROR', '', { cause: upstream });
      },
    });

    await expect(connection.call('fail', { agentUserId: 'agent-42' })).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
      message: 'upstream quota exhausted',
      details: {
        code: 'UPSTREAM_RATE_LIMIT',
        status: 429,
        response: { retryable: false, provider: 'codex' },
      },
      context: {
        path: 'fail',
        agentUserId: 'agent-42',
      },
    });
  });

  it('preserves serialized causes on thrown wire errors', async () => {
    const failingContract = defineContract({
      fail: procedure({ input: z.void().optional(), output: z.void() }),
    });
    const cause = new Error('root cause');
    const { connection } = createTestWire(failingContract, {
      fail: () => {
        throw new WireError('NOT_FOUND', 'missing resource', { cause });
      },
    });

    await expect(connection.call('fail', undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'missing resource',
      cause: {
        name: 'Error',
        message: 'root cause',
      },
    });
  });

  it('narrows wire errors with and without a code argument', () => {
    const error: unknown = new WireError('CANCELLED', 'cancelled');

    expect(isWireError(error)).toBe(true);
    expect(isWireError(error, 'CANCELLED')).toBe(true);
    expect(isWireError(error, 'DISCONNECTED')).toBe(false);
    expect(isWireError(new Error('plain'))).toBe(false);
  });

  it('supports fallible procedures that return typed Result payloads', async () => {
    const fallibleContract = defineContract({
      load: fallible({
        input: z.object({ id: z.string() }),
        data: z.object({ value: z.string() }),
        error: z.object({ type: z.literal('missing') }),
      }),
    });
    const { connection } = createTestWire(
      fallibleContract,
      {
        load: ({ id }) =>
          id === 'known' ? ok({ value: 'found' }) : err({ type: 'missing' as const }),
      },
      { validate: 'full' }
    );

    await expect(connection.call('load', { id: 'known' })).resolves.toEqual(ok({ value: 'found' }));
    await expect(connection.call('load', { id: 'missing' })).resolves.toEqual(
      err({ type: 'missing' })
    );
  });

  it('snapshots and subscribes to live sources with refcounted detach', async () => {
    const { connection, model } = setup();
    const topic = encodeTopic(contract.state.states.state.id, { id: 'known' });
    await expect(connection.snapshot(topic)).resolves.toMatchObject({ data: { count: 0 } });

    const updates: LiveUpdate[] = [];
    const delivered = deferred();
    const detach = await connection.attach(topic, (update) => {
      updates.push(update);
      delivered.resolve();
    });
    model.produce((draft) => {
      draft.count = 1;
    });
    await delivered.promise;
    detach();
    model.produce((draft) => {
      draft.count = 2;
    });
    await Promise.resolve();
    expect(updates).toHaveLength(1);
  });

  it('surfaces attach failures for unknown topics', async () => {
    const { connection } = setup();
    await expect(connection.attach('missing.topic', () => {})).rejects.toMatchObject({
      code: 'UNKNOWN_TOPIC',
    });
  });

  it('removes failed attachment entries so later attaches can retry the topic', async () => {
    const pair = memoryTransportPair();
    let available = false;
    let resolveCount = 0;
    const source: LiveSource = {
      snapshot: () => ({ generation: 1, sequence: 0, timestamp: 0, data: {} }),
      subscribe: () => () => {},
    };
    const controller = {
      call: () => {
        throw new WireError('UNKNOWN_PROCEDURE', 'not implemented');
      },
      resolveLive: (topic: string) => {
        resolveCount += 1;
        return available && topic === 'dynamic.topic' ? source : null;
      },
    };
    serve(pair.right, controller);
    const connection = connect(pair.left);

    await expect(connection.attach('dynamic.topic', () => {})).rejects.toMatchObject({
      code: 'UNKNOWN_TOPIC',
    });

    available = true;
    const detach = await connection.attach('dynamic.topic', () => {});
    expect(resolveCount).toBe(2);
    detach();
  });

  it('reports retryable reattach failures and keeps the attachment durable', async () => {
    const transport = new ControlledTransport();
    const connection = connect(transport);
    const updates: LiveUpdate[] = [];
    const gaps: string[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const gapReported = deferred();
    const errorReported = deferred();

    const attached = connection.attach('live.topic', (update) => updates.push(update), {
      onReattach: () => {
        gaps.push('gap');
        gapReported.resolve();
      },
      onReattachError: (error, context) => {
        errors.push({ code: error.code, retrying: context.retrying });
        errorReported.resolve();
      },
    });
    transport.resolveAttach('live.topic');
    const detach = await attached;

    transport.reconnect();
    transport.rejectAttach('live.topic', 'DISCONNECTED');
    await errorReported.promise;

    transport.reconnect();
    transport.resolveAttach('live.topic');
    await gapReported.promise;
    transport.emit({
      kind: 'update',
      topic: 'live.topic',
      update: {
        generation: 1,
        baseSequence: 0,
        sequence: 1,
        timestamp: 0,
        delta: {},
      },
    });

    expect(errors).toEqual([{ code: 'DISCONNECTED', retrying: true }]);
    expect(updates).toHaveLength(1);
    detach();
    expect(transport.sent).toContainEqual({ kind: 'detach', topic: 'live.topic' });
  });

  it('terminates attachments on non-retryable reattach failures', async () => {
    const transport = new ControlledTransport();
    const connection = connect(transport);
    const updates: LiveUpdate[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const errorReported = deferred();

    const attached = connection.attach('live.topic', (update) => updates.push(update), {
      onReattachError: (error, context) => {
        errors.push({ code: error.code, retrying: context.retrying });
        errorReported.resolve();
      },
    });
    transport.resolveAttach('live.topic');
    const detach = await attached;

    transport.reconnect();
    transport.rejectAttach('live.topic', 'UNKNOWN_TOPIC');
    await errorReported.promise;
    transport.emit({
      kind: 'update',
      topic: 'live.topic',
      update: {
        generation: 1,
        baseSequence: 0,
        sequence: 1,
        timestamp: 0,
        delta: {},
      },
    });
    detach();

    expect(errors).toEqual([{ code: 'UNKNOWN_TOPIC', retrying: false }]);
    expect(updates).toEqual([]);
    expect(transport.sent).not.toContainEqual({ kind: 'detach', topic: 'live.topic' });
  });

  it('ignores stale reattach failures from older attempts', async () => {
    const transport = new ControlledTransport();
    const connection = connect(transport);
    const updates: LiveUpdate[] = [];
    const gaps: string[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const gapReported = deferred();

    const attached = connection.attach('live.topic', (update) => updates.push(update), {
      onReattach: () => {
        gaps.push('gap');
        gapReported.resolve();
      },
      onReattachError: (error, context) =>
        errors.push({ code: error.code, retrying: context.retrying }),
    });
    transport.resolveAttach('live.topic');
    const detach = await attached;

    transport.reconnect();
    const staleAttachId = transport.latestAttachId('live.topic');
    transport.reconnect();
    transport.rejectAttach('live.topic', 'UNKNOWN_TOPIC', staleAttachId);
    transport.resolveAttach('live.topic');
    await gapReported.promise;
    transport.emit({
      kind: 'update',
      topic: 'live.topic',
      update: {
        generation: 1,
        baseSequence: 0,
        sequence: 1,
        timestamp: 0,
        delta: {},
      },
    });

    expect(errors).toEqual([]);
    expect(updates).toHaveLength(1);
    detach();
  });

  it('cleans server subscriptions on disconnect', async () => {
    let detachCount = 0;
    const source: LiveSource = {
      snapshot: () => ({ generation: 1, sequence: 0, timestamp: 0, data: {} }),
      subscribe: () => {
        return () => {
          detachCount += 1;
        };
      },
    };
    const pair = memoryTransportPair();
    const cleanupContract = defineContract({
      state: liveModel({
        key: z.void().optional(),
        states: { state: liveState({ data: z.object({}) }) },
      }),
    });
    const controller = createController(cleanupContract, {
      state: {
        kind: 'liveModelProvider',
        contract: cleanupContract.state,
        resolveState: () => source,
        runMutation: async () => ok({ data: undefined, cursors: [] }),
      },
    });
    serve(pair.right, controller);
    const connection = connect(pair.left);
    await connection.attach(
      encodeTopic(cleanupContract.state.states.state.id, undefined),
      () => {}
    );
    pair.disconnect();
    expect(detachCount).toBe(1);
  });

  it('does not throw when an attachment is detached after disconnect', async () => {
    const { connection, pair, model } = setup();
    const topic = encodeTopic(contract.state.states.state.id, { id: 'known' });
    const updates: LiveUpdate[] = [];
    const detach = await connection.attach(topic, (update) => updates.push(update));
    pair.left.disconnect();
    await expect(connection.call('greet', { name: 'after' })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
    expect(() => {
      model.produce((draft) => {
        draft.count = 1;
      });
    }).not.toThrow();
    expect(() => detach()).not.toThrow();
  });

  it('reattaches and refreshes bound live models after reconnect', async () => {
    const host = createLiveModelHost(contract.state);
    const instance = host.create({ id: 'known' }, { state: { count: 0 } });
    const model = instance.states.state;
    const controller = createController(contract, {
      greet: ({ name }) => `hello ${name}`,
      fail: () => {
        throw new WireError('NOT_FOUND', 'expected failure');
      },
      state: host,
    });
    const pairs: ReturnType<typeof memoryTransportPair>[] = [];
    const serverDisposers: Unsubscribe[] = [];
    const reconnected = deferred();
    const transport = reconnectingTransport(async () => {
      const pair = memoryTransportPair();
      pairs.push(pair);
      serverDisposers.push(serve(pair.right, controller));
      if (pairs.length === 2) reconnected.resolve();
      return pair.left;
    });
    const contractClient = client(contract, connect(transport));
    const seen: Array<{ count: number }> = [];
    const countSeen = new Map([1, 9].map((count) => [count, deferred()]));
    const binding = new ReplicaState(contractClient.state.state({ id: 'known' }, 'state'), {
      schema: z.object({ count: z.number() }),
      onChange: (value) => {
        seen.push(value);
        countSeen.get(value.count)?.resolve();
      },
    });

    await binding.ready;
    model.produce((draft) => {
      draft.count = 1;
    });
    await countSeen.get(1)!.promise;
    expect(binding.current().count).toBe(1);

    pairs[0]?.disconnect();
    model.reseed({ count: 9 });

    await reconnected.promise;
    await countSeen.get(9)!.promise;
    expect(binding.current().count).toBe(9);
    expect(seen.at(-1)).toEqual({ count: 9 });

    await binding.dispose();
    transport.close();
    for (const dispose of serverDisposers) dispose();
  });

  // #7327:进程重启之后,那一份实例在新进程里根本不存在。副本若只是不吭声地停在旧值上,持有者会一直以为
  // 它还活着 —— 会话页拿着一个死掉的句柄,打一个字就被运行时拒一次「草稿没存上」。
  it('tells its holder when the upstream instance is gone after a reconnect', async () => {
    const before = createLiveModelHost(contract.state);
    before.create({ id: 'known' }, { state: { count: 4 } });
    // 重启后的那一边:同一份契约,一个实例都还没建。
    const after = createLiveModelHost(contract.state);
    const handlers = {
      greet: ({ name }: { name: string }) => `hello ${name}`,
      fail: () => {
        throw new WireError('NOT_FOUND', 'expected failure');
      },
    };
    const controllers = [
      createController(contract, { ...handlers, state: before }),
      createController(contract, { ...handlers, state: after }),
    ];
    const pairs: ReturnType<typeof memoryTransportPair>[] = [];
    const serverDisposers: Unsubscribe[] = [];
    const transport = reconnectingTransport(async () => {
      const pair = memoryTransportPair();
      serverDisposers.push(serve(pair.right, controllers[Math.min(pairs.length, 1)]!));
      pairs.push(pair);
      return pair.left;
    });
    const contractClient = client(contract, connect(transport));
    const gone = deferred<string>();
    const binding = new ReplicaState(contractClient.state.state({ id: 'known' }, 'state'), {
      schema: z.object({ count: z.number() }),
    });
    binding.onGone((error) => gone.resolve(error.code));

    await binding.ready;
    expect(binding.current().count).toBe(4);
    pairs[0]?.disconnect();

    expect(await gone.promise).toBe('NOT_FOUND');
    // 最后读到的值原样留着:那是这条会话停下前的样子,不是新进程给的说法。
    expect(binding.current().count).toBe(4);

    await binding.dispose();
    transport.close();
    for (const dispose of serverDisposers) dispose();
  });

  // @@@follow-key(10-19):会话停掉(实例拆掉)后被宿主自己按同一个 key 再拉起来(定时、投递)。订阅只订住旧实例时,
  // 新实例的变化一条都到不了 —— 任务页停在旧画面,要等人发一句才看得到。经一层转发(渲染层 → 主进程 → 运行时)同样要接上。
  for (const hops of [1, 2] as const) {
    it(`follows the key when its instance is disposed and created again (${hops} hop${hops > 1 ? 's' : ''})`, async () => {
      const host = createLiveModelHost(contract.state);
      host.create({ id: 'known' }, { state: { count: 4 } });
      const impl = {
        greet: ({ name }: { name: string }) => `hello ${name}`,
        fail: () => {
          throw new WireError('NOT_FOUND', 'expected failure');
        },
      };
      const upstream = createTestWire(contract, { ...impl, state: host });
      const wire = hops === 1 ? upstream : createTestWire(contract, forwardController(contract, upstream.client));
      const seen = new Map([5, 7, 8].map((count) => [count, deferred()] as const));
      const binding = new ReplicaState(wire.client.state.state({ id: 'known' }, 'state'), {
        schema: z.object({ count: z.number() }),
        onChange: (value) => seen.get(value.count)?.resolve(),
      });
      const gone = deferred<string>();
      binding.onGone((error) => gone.resolve(error.code));
      await binding.ready;

      host.get({ id: 'known' })!.states.state.produce((draft) => {
        draft.count = 5;
      });
      await seen.get(5)!.promise;

      host.get({ id: 'known' })!.dispose();
      expect(await gone.promise).toBe('NOT_FOUND');
      expect(binding.current().count, 'the last value stays: how it was before it stopped').toBe(5);

      const again = host.create({ id: 'known' }, { state: { count: 7 } });
      await seen.get(7)!.promise;
      again.states.state.produce((draft) => {
        draft.count = 8;
      });
      await seen.get(8)!.promise;
      expect(binding.current().count).toBe(8);

      await binding.dispose();
      wire.dispose();
      if (wire !== upstream) upstream.dispose();
    });
  }

  it('a snapshot of a key with no instance is NOT_FOUND, and attaching to it is allowed', async () => {
    const { connection } = setup();
    const topic = encodeTopic(contract.state.states.state.id, { id: 'nobody' });
    await expect(connection.snapshot(topic)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('Unknown live topic') });
    const detach = await connection.attach(topic, () => undefined);
    detach();
  });

  it('cancels an in-flight call with a caller signal', async () => {
    // 处理器的结果在服务端看到中止之后才放出来:切断那一刻调用一定还在途,不取决于真定时器与切断谁先到。
    const late = deferred<string>();
    const started = deferred();
    const aborted = deferred();
    const pair = memoryTransportPair();
    const slowContract = defineContract({
      slow: procedure({ input: z.void().optional(), output: z.string() }),
    });
    const controller = createController(slowContract, {
      slow: (_input, meta) =>
        new Promise<string>((resolve, reject) => {
          started.resolve();
          if (meta.signal?.aborted) {
            aborted.resolve();
            reject(new Error('aborted'));
            return;
          }
          meta.signal?.addEventListener('abort', () => {
            aborted.resolve();
            reject(new Error('aborted'));
          });
          void late.promise.then(resolve);
        }),
    });
    const serverEvents: unknown[] = [];
    serve(pair.right, controller, {
      instrumentation: {
        cancel: (event) => serverEvents.push({ kind: 'cancel', event }),
        callEnd: (event) => serverEvents.push({ kind: 'callEnd', event }),
      },
    });
    const connection = connect(pair.left);
    const abort = new AbortController();

    const result = connection.call('slow', undefined, { signal: abort.signal });
    await started.promise;
    abort.abort();
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    await aborted.promise;
    late.resolve('late');
    await rejected;
    expect(serverEvents).toContainEqual({
      kind: 'cancel',
      event: expect.objectContaining({ callId: expect.any(String), side: 'server' }),
    });
    expect(serverEvents).toContainEqual({
      kind: 'callEnd',
      event: expect.objectContaining({
        ok: false,
        errorCode: 'CANCELLED',
        side: 'server',
      }),
    });
  });

  it('rejects pre-aborted calls without posting', async () => {
    const { connection } = setup();
    const abort = new AbortController();
    abort.abort();

    await expect(
      connection.call('greet', { name: 'wire' }, { signal: abort.signal })
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('aborts in-flight calls when the transport disconnects', async () => {
    // 处理器的结果在服务端看到中止之后才放出来:切断那一刻调用一定还在途,不取决于真定时器与切断谁先到。
    const late = deferred<string>();
    const started = deferred();
    const aborted = deferred();
    const pair = memoryTransportPair();
    const slowContract = defineContract({
      slow: procedure({ input: z.void().optional(), output: z.string() }),
    });
    const controller = createController(slowContract, {
      slow: (_input, meta) =>
        new Promise<string>((resolve, reject) => {
          started.resolve();
          if (meta.signal?.aborted) {
            aborted.resolve();
            reject(new Error('aborted'));
            return;
          }
          meta.signal?.addEventListener('abort', () => {
            aborted.resolve();
            reject(new Error('aborted'));
          });
          void late.promise.then(resolve);
        }),
    });
    serve(pair.right, controller);
    const connection = connect(pair.left);

    const result = connection.call('slow', undefined);
    await started.promise;
    pair.disconnect();
    const rejected = expect(result).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await aborted.promise;
    late.resolve('late');
    await rejected;
  });

  it('ignores a late result after local cancellation', async () => {
    const gate = deferred<string>();
    const pair = memoryTransportPair();
    const slowContract = defineContract({
      slow: procedure({ input: z.void().optional(), output: z.string() }),
    });
    const controller = createController(slowContract, { slow: () => gate.promise });
    serve(pair.right, controller);
    const connection = connect(pair.left);
    const abort = new AbortController();

    const result = connection.call('slow', undefined, { signal: abort.signal });
    abort.abort();

    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    gate.resolve('late');
    await Promise.resolve();
  });
});

class ControlledTransport implements WireTransport {
  readonly sent: WireMessage[] = [];
  private readonly messageListeners = new Set<(message: WireMessage) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();

  post(message: WireMessage): void {
    this.sent.push(message);
  }

  onMessage(cb: (message: WireMessage) => void): Unsubscribe {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onDisconnect(cb: () => void): Unsubscribe {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  onReconnect(cb: () => void): Unsubscribe {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  emit(message: WireMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  reconnect(): void {
    for (const listener of this.reconnectListeners) listener();
  }

  resolveAttach(topic: string): void {
    this.emit({ kind: 'result', id: this.latestAttachId(topic), ok: true, value: undefined });
  }

  rejectAttach(topic: string, code: WireError['code'], id = this.latestAttachId(topic)): void {
    this.emit({ kind: 'result', id, ok: false, code, message: `${code} ${topic}` });
  }

  latestAttachId(topic: string): string {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const message = this.sent[index];
      if (message.kind === 'attach' && message.topic === topic) return message.id;
    }
    throw new Error(`No attach message sent for ${topic}`);
  }
}
