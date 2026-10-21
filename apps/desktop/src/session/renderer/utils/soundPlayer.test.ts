/**
 * 提示音响完要把 AudioContext 挂起:running 的上下文一直在渲染静音(声卡流开着、实时音频线程
 * 持续唤醒),而提示音一次不到一秒。
 *
 * 读数 = 假 AudioContext 上 suspend/resume 的调用次数与 state。阳控:第一声之后 state 必须先是
 * running(否则「最后是 suspended」可以是它从来没 running 过)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc', () => ({ rpc: { appSettings: { getWithMeta: () => new Promise(() => {}) } } }));
vi.mock('../lib/query-client', () => ({
  queryClient: { getQueryCache: () => ({ subscribe: () => () => {} }), setQueryData: () => {} },
}));

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = new FakeNode();
  // Like the real thing, state changes only when the promise settles (a microtask later), and the
  // operations settle in call order.
  suspend = vi.fn(() => Promise.resolve().then(() => {
    this.state = 'suspended';
  }));
  resume = vi.fn(() => Promise.resolve().then(() => {
    this.state = 'running';
  }));
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    return Object.assign(new FakeNode(), { type: 'sine', frequency: { value: 0 }, start() {}, stop() {} });
  }
  createGain() {
    return Object.assign(new FakeNode(), {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('soundPlayer suspends its AudioContext between sounds', () => {
  it('suspends after the tones end and resumes for the next sound', async () => {
    const { soundPlayer } = await import('./soundPlayer');
    soundPlayer.play('task_complete');
    const [ctx] = FakeAudioContext.instances;
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx!.state).toBe('running');

    // Still playing (last tone ends at 0.56s): not suspended yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx!.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(ctx!.suspend).toHaveBeenCalledTimes(1);
    expect(ctx!.state).toBe('suspended');

    soundPlayer.play('needs_attention');
    await Promise.resolve();
    expect(ctx!.resume).toHaveBeenCalled();
    expect(ctx!.state).toBe('running');
    expect(FakeAudioContext.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_300);
    expect(ctx!.suspend).toHaveBeenCalledTimes(2);
    expect(ctx!.state).toBe('suspended');
  });

  it('a sound inside the idle window cancels the pending suspend', async () => {
    const { soundPlayer } = await import('./soundPlayer');
    soundPlayer.play('needs_attention');
    const [ctx] = FakeAudioContext.instances;
    await vi.advanceTimersByTimeAsync(1_000);
    soundPlayer.play('task_complete');
    await vi.advanceTimersByTimeAsync(1_000);
    // The first sound's suspend would have fired at 1.27s; it was cancelled by the second sound.
    expect(ctx!.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(ctx!.suspend).toHaveBeenCalledTimes(1);
  });

  it('a sound that lands while a suspend is still settling resumes the context', async () => {
    const { soundPlayer } = await import('./soundPlayer');
    soundPlayer.play('needs_attention');
    const [ctx] = FakeAudioContext.instances;
    // Fire the idle suspend, but stop before its promise settles: state still reads 'running'.
    vi.advanceTimersByTime(1_300);
    expect(ctx!.suspend).toHaveBeenCalledTimes(1);
    expect(ctx!.state).toBe('running');
    soundPlayer.play('task_complete');
    await Promise.resolve();
    await Promise.resolve();
    // suspend settled first, then the resume issued by the second sound: the chime is audible.
    expect(ctx!.state).toBe('running');
  });
});
