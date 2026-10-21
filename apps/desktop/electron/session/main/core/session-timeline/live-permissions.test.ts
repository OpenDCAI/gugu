import type { PendingRequest } from '@gugu/session-core/session-record/contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 假的 ReplicaState:按 handle 的 topic 区分「会话表」与「某条会话的 state」,测试手动推值。
type FakeReplica = {
  topic: string;
  value: unknown;
  onChange?: (value: unknown) => void;
  disposed: boolean;
  ready: Promise<void>;
};
const runtime = vi.hoisted(() => ({ available: true, spawned: null as null | (() => void), unlisten: vi.fn() }));
const replicas: FakeReplica[] = [];
const failNextReady = new Set<string>();

vi.mock('@gugu/session-wire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/session-wire')>()),
  ReplicaState: class {
    private readonly r: FakeReplica;
    constructor(handle: { topic: string; value: unknown }, deps: { onChange?: (value: unknown) => void }) {
      const ready = failNextReady.delete(handle.topic)
        ? Promise.reject(new Error(`Unknown live topic '${handle.topic}'`))
        : Promise.resolve();
      this.r = { topic: handle.topic, value: handle.value, onChange: deps.onChange, disposed: false, ready };
      replicas.push(this.r);
    }
    get ready() {
      return this.r.ready;
    }
    current() {
      return this.r.value;
    }
    dispose() {
      this.r.disposed = true;
    }
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/core/acp/runtime-process/host', () => ({
  onAcpRuntimeSpawned: (listener: () => void) => { runtime.spawned = listener; return runtime.unlisten; },
  peekAcpRuntimeClient: async () => !runtime.available ? null : ({
    sessions: { state: () => ({ topic: 'list', value: {} }) },
    session: {
      state: ({ sessionId }: { sessionId: string }, topic: string) => ({
        topic: topic === 'activeTurn' ? `active:${sessionId}` : `session:${sessionId}`,
        value: topic === 'activeTurn' ? null : { pendingPermissions: [], queuedPrompts: [], isGenerating: true },
      }),
    },
  }),
}));

const { watchSessionState } = await import('./live-permissions');

const push = (topic: string, value: unknown) => {
  const replica = replicas.filter((r) => r.topic === topic && !r.disposed).at(-1);
  if (!replica) throw new Error(`no live replica for ${topic}`);
  replica.value = value;
  replica.onChange?.(value);
};
const summary = (sessionId: string, lifecycle = 'ready') => ({ sessionId, lifecycle });
const permission = {
  requestId: 'req-1',
  toolCall: { kind: 'execute-tool-call', title: 'touch /tmp/x', command: 'touch /tmp/x' },
  options: [{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }],
};

describe('watchSessionState', () => {
  beforeEach(() => {
    replicas.length = 0;
    runtime.available = true; runtime.spawned = null; runtime.unlisten.mockClear();
  });

  it('attaches when the ACP session appears after the timeline opened, and clears when it goes away', async () => {
    const seen: PendingRequest[][] = [];
    const queued: string[][] = [];
    const watch = await watchSessionState('conv-late', (requests, queuedPrompts) => {
      seen.push(requests);
      queued.push(queuedPrompts.map((prompt) => prompt.text));
    });
    expect(watch).not.toBeNull();
    // 会话还不在:❌ 不许去订一条必然 NOT_FOUND 的 session.state。
    expect(replicas.map((r) => r.topic)).toEqual(['list']);

    push('list', { 'conv-late': summary('conv-late') });
    await Promise.resolve();
    expect(replicas.map((r) => r.topic)).toEqual(['list', 'session:conv-late', 'active:conv-late']);

    const queuedPrompt = { id: 'qp-1', text: '排着的那句', createdAt: 1, updatedAt: 1 };
    push('session:conv-late', { pendingPermissions: [permission], queuedPrompts: [queuedPrompt] });
    expect(seen.at(-1)?.map((r) => r.itemId)).toEqual(['req-1']);
    // 排队提示随同一份 session.state 到(桌面「Queued prompts」读的就是它)。
    expect(queued.at(-1)).toEqual(['排着的那句']);

    // 会话结束:还留在表里,只是 lifecycle=closed ⇒ 同样拆掉、报空。
    push('list', { 'conv-late': summary('conv-late', 'closed') });
    expect(seen.at(-1)).toEqual([]);
    expect(queued.at(-1)).toEqual([]);
    expect(replicas.find((r) => r.topic === 'session:conv-late')?.disposed).toBe(true);

    watch!.dispose();
    expect(replicas.every((r) => r.disposed)).toBe(true);
  });

  it('re-attaches on the next list change when attaching the session state failed once', async () => {
    const seen: PendingRequest[][] = [];
    const watch = await watchSessionState('conv-flaky', (requests) => seen.push(requests));
    failNextReady.add('session:conv-flaky');
    push('list', { 'conv-flaky': summary('conv-flaky') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 第一份死在 ready 上;会话表再变一次 ⇒ 必须再接一份,而不是以为已经接上。
    push('list', { 'conv-flaky': summary('conv-flaky'), other: summary('other') });
    expect(replicas.filter((r) => r.topic === 'session:conv-flaky')).toHaveLength(2);
    push('session:conv-flaky', { pendingPermissions: [permission], queuedPrompts: [] });
    expect(seen.at(-1)?.map((r) => r.itemId)).toEqual(['req-1']);
    watch!.dispose();
  });
  it('streams thinking before any record write and clears on idle, loss and disposal', async () => {
    const seen: unknown[] = [];
    const watch = await watchSessionState('live', (_requests, _queue, reply) => seen.push(reply));
    push('list', { live: summary('live') });
    await Promise.resolve();
    push('session:live', { pendingPermissions: [], queuedPrompts: [], isGenerating: true });
    push('active:live', { id: 'turn', seq: 1, initiator: 'user', items: [
      { kind: 'message', id: 'in', seq: 0, role: 'user', text: '<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:one" chat="dm"><![CDATA[Hi]]></gugu_delivery>' },
      { kind: 'thinking', id: 'thought', seq: 1, segmentId: 's', text: 'streamed', status: 'thinking', startedAt: 1_000 },
    ] });
    expect(seen.at(-1)).toMatchObject({ sourceMessageId: 'msg:one', activity: { phase: 'thinking', text: 'streamed', startedAt: 1_000 } });
    push('session:live', { pendingPermissions: [], queuedPrompts: [], isGenerating: false });
    expect(seen.at(-1)).toBeNull();
    push('list', { live: summary('live', 'lost') });
    expect(seen.at(-1)).toBeNull();
    expect(replicas.filter((r) => r.topic === 'active:live').every((r) => r.disposed)).toBe(true);
    watch!.dispose();
    expect(replicas.every((r) => r.disposed)).toBe(true);
  });

  it('attaches when the runtime starts later and detaches the old stream when it is replaced', async () => {
    runtime.available = false;
    const seen: unknown[] = [];
    const watch = await watchSessionState('late-runtime', (_requests, _queue, reply) => seen.push(reply));
    expect(replicas).toEqual([]);
    runtime.available = true;
    runtime.spawned!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    push('list', { 'late-runtime': summary('late-runtime') });
    await Promise.resolve();
    expect(replicas.some((replica) => replica.topic === 'active:late-runtime')).toBe(true);
    const old = replicas.filter((replica) => !replica.disposed);
    runtime.spawned!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(old.every((replica) => replica.disposed)).toBe(true);
    expect(seen.at(-1)).toBeNull();
    watch.dispose();
    expect(runtime.unlisten).toHaveBeenCalledTimes(1);
    expect(replicas.every((replica) => replica.disposed)).toBe(true);
  });

});
