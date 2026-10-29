// @vitest-environment jsdom
/**
 * #980 不叫醒就知道它在不在跑:判据(与主进程 `watchRunningSessionState` 同一条)与「一台机器共用一份会话表」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fake = {
  value: Record<string, unknown>;
  onChange: () => void;
  gone: Array<(error: unknown) => void>;
  disposed: boolean;
};
const replicas = vi.hoisted(() => [] as Fake[]);
vi.mock('@gugu/session-wire', () => ({
  ReplicaState: class {
    readonly ready = Promise.resolve();
    private readonly fake: Fake;
    constructor(_handle: unknown, deps: { onChange: () => void }) {
      this.fake = { value: {}, onChange: deps.onChange, gone: [], disposed: false };
      replicas.push(this.fake);
    }
    current() { return this.fake.value; }
    onGone(cb: (error: unknown) => void) { this.fake.gone.push(cb); return () => undefined; }
    async dispose() { this.fake.disposed = true; }
  },
}));
vi.mock('./runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ sessions: { state: () => ({}) } }),
}));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: () => undefined } }));

const { runningPhase, watchRunningSession } = await import('./running-sessions');

const row = (sessionId: string, lifecycle: string, closing?: boolean) => ({ sessionId, lifecycle, ...(closing ? { closing } : {}) });

beforeEach(() => {
  replicas.length = 0;
});

describe('runningPhase', () => {
  it('表里没有、closed、lost、正在收口 = 没在跑;starting / replaying = 正被拉起来;其余 = 在跑', () => {
    expect(runningPhase({}, 'a')).toBe('stopped');
    expect(runningPhase({ a: row('a', 'closed') }, 'a')).toBe('stopped');
    expect(runningPhase({ a: row('a', 'lost') }, 'a')).toBe('stopped');
    expect(runningPhase({ a: row('a', 'working', true) }, 'a')).toBe('stopped');
    expect(runningPhase({ a: row('a', 'starting') }, 'a')).toBe('starting');
    expect(runningPhase({ a: row('a', 'replaying') }, 'a')).toBe('starting');
    expect(runningPhase({ a: row('a', 'ready') }, 'a')).toBe('running');
    expect(runningPhase({ a: row('a', 'working') }, 'a')).toBe('running');
    expect(runningPhase({ a: row('a', 'cancelling') }, 'a')).toBe('running');
    // 键不是会话 id 的那种表(按 sessionId 找)。
    expect(runningPhase({ k: row('a', 'ready') }, 'a')).toBe('running');
  });
});

describe('watchRunningSession', () => {
  it('同一台机器只订一份会话表;变了每个订的都响;最后一个放手才拆', async () => {
    const changes: string[] = [];
    const a = await watchRunningSession('sess-a', { onChange: () => changes.push('a'), onGone: () => undefined });
    const b = await watchRunningSession('sess-b', { onChange: () => changes.push('b'), onGone: () => undefined });
    expect(replicas).toHaveLength(1);

    replicas[0]!.value = { 'sess-a': row('sess-a', 'ready') };
    replicas[0]!.onChange();
    expect(changes).toEqual(['a', 'b']);
    expect(a.phase()).toBe('running');
    expect(b.phase()).toBe('stopped');

    a.dispose();
    expect(replicas[0]!.disposed).toBe(false);
    b.dispose();
    expect(replicas[0]!.disposed).toBe(true);

    // 拆了之后再订:重新订一份。
    const c = await watchRunningSession('sess-a', { onChange: () => undefined, onGone: () => undefined });
    expect(replicas).toHaveLength(2);
    c.dispose();
  });

  it('那份表没了:告诉每个订的(由它们重订),下一个来订的拿到新的一份', async () => {
    const gone: string[] = [];
    const a = await watchRunningSession('sess-a', { onChange: () => undefined, onGone: () => gone.push('a') });
    replicas[0]!.gone.forEach((cb) => cb(new Error('NOT_FOUND')));
    expect(gone).toEqual(['a']);
    expect(replicas[0]!.disposed).toBe(true);

    const b = await watchRunningSession('sess-a', { onChange: () => undefined, onGone: () => undefined });
    expect(replicas).toHaveLength(2);
    a.dispose();
    b.dispose();
  });
});
