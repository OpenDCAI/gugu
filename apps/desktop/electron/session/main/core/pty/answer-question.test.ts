import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pty } from './pty';
import { writeKeyBeats } from './answer-question';
import { ptySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));

const SESSION = 'proj-1:task-1:conv-1';
const PACING = { settleMs: 20, maxWaitMs: 2000 };

/** 终端桩:`renderAfterMs` 为数字时,每次写入之后隔这么久吐一段重画;null = 写了也不重画。 */
function fakeTerminal(renderAfterMs: number | null) {
  let onData: (data: string) => void = () => {};
  const writes: Array<{ data: string; at: number }> = [];
  const pty: Pty = {
    write: (data) => {
      writes.push({ data, at: Date.now() });
      if (renderAfterMs !== null) setTimeout(() => onData(`<drawn ${JSON.stringify(data)}>`), renderAfterMs);
    },
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (handler) => (onData = handler),
    onExit: () => {},
  };
  return { pty, writes, out: (data: string) => onData(data) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  ptySessionRegistry.unregister(SESSION);
  vi.useRealTimers();
});

describe('writeKeyBeats(#6798)', () => {
  it('一拍一次 write;下一拍在上一拍重画完、静够 settleMs 之后才写', async () => {
    const terminal = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
    const done = writeKeyBeats(SESSION, ['1', '\t', '\r'], PACING, { askedAt: undefined, stillOpen: async () => true });
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toEqual({ success: true, data: { written: 3 } });
    expect(terminal.writes.map((w) => w.data)).toEqual(['1', '\t', '\r']);
    for (let i = 1; i < terminal.writes.length; i++) {
      // 前一拍的重画在 +5ms,再静 20ms ⇒ 间隔至少 25ms。
      expect(terminal.writes[i].at - terminal.writes[i - 1].at).toBeGreaterThanOrEqual(25);
    }
  });

  it('选择器关了:立刻停,剩下的键一个不写', async () => {
    const terminal = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
    const open = [true, false];
    const done = writeKeyBeats(SESSION, ['1', '2', '\r'], PACING, { askedAt: undefined, stillOpen: async () => open.shift() ?? false });
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toMatchObject({ success: false, error: { type: 'question_closed', written: 1 } });
    expect(terminal.writes.map((w) => w.data)).toEqual(['1']);
  });

  it('一开始就关着:一个字节都不写', async () => {
    const terminal = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
    const done = writeKeyBeats(SESSION, ['1'], PACING, { askedAt: undefined, stillOpen: async () => false });
    await vi.advanceTimersByTimeAsync(100);
    expect(await done).toMatchObject({ success: false, error: { type: 'question_closed', written: 0 } });
    expect(terminal.writes).toEqual([]);
  });

  it('写了不重画 ⇒ maxWaitMs 后停;写之前的旧输出不算这一拍的重画', async () => {
    const terminal = fakeTerminal(null);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
    terminal.out('早先画的');
    await vi.advanceTimersByTimeAsync(100);
    const done = writeKeyBeats(SESSION, ['1', '2'], PACING, { askedAt: undefined, stillOpen: async () => true });
    await vi.advanceTimersByTimeAsync(PACING.maxWaitMs + 100);
    expect(await done).toMatchObject({ success: false, error: { type: 'render_timeout', written: 1 } });
    expect(terminal.writes.map((w) => w.data)).toEqual(['1']);
  });

  it('不是 agent 会话的 pty、或根本没有 pty:一个字节都不写', async () => {
    const terminal = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 } });
    expect(await writeKeyBeats(SESSION, ['1'], PACING, { askedAt: undefined, stillOpen: async () => true })).toMatchObject({
      success: false,
      error: { type: 'not_a_conversation', written: 0 },
    });
    ptySessionRegistry.unregister(SESSION);
    expect(await writeKeyBeats(SESSION, ['1'], PACING, { askedAt: undefined, stillOpen: async () => true })).toMatchObject({
      success: false,
      error: { type: 'not_found', written: 0 },
    });
    expect(terminal.writes).toEqual([]);
  });

  it('agent 进程是题目问出来之后才起的(resume)⇒ 一个字节都不写;tmux 接回(不知道何时起的)与更早起的照写', async () => {
    const terminal = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude', agentStartedAt: 2000 } });
    // 推着假时钟等:判据失效时它会去写、去等重画,这里要红,❌ 挂住。
    const gone = writeKeyBeats(SESSION, ['1'], PACING, { askedAt: 1000, stillOpen: async () => true });
    await vi.advanceTimersByTimeAsync(200);
    expect(await gone).toMatchObject({ success: false, error: { type: 'question_gone', written: 0 } });
    expect(terminal.writes).toEqual([]);

    for (const metadata of [{ providerId: 'claude' as const, agentStartedAt: 500 }, { providerId: 'claude' as const }]) {
      ptySessionRegistry.register(SESSION, terminal.pty, { size: { cols: 80, rows: 24 }, metadata });
      const done = writeKeyBeats(SESSION, ['1'], PACING, { askedAt: 1000, stillOpen: async () => true });
      await vi.advanceTimersByTimeAsync(200);
      expect(await done, JSON.stringify(metadata)).toMatchObject({ success: true });
    }
    expect(terminal.writes.map((w) => w.data)).toEqual(['1', '1']);
  });

  it('写到一半 pty 换代(agent 重启):停,不往新进程里接着敲', async () => {
    const first = fakeTerminal(5);
    const second = fakeTerminal(5);
    ptySessionRegistry.register(SESSION, first.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
    const done = writeKeyBeats(SESSION, ['1', '2'], PACING, {
      askedAt: undefined,
      stillOpen: async () => {
        if (first.writes.length === 1) ptySessionRegistry.register(SESSION, second.pty, { size: { cols: 80, rows: 24 }, metadata: { providerId: 'claude' } });
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toMatchObject({ success: false, error: { type: 'not_found', written: 1 } });
    expect(first.writes.map((w) => w.data)).toEqual(['1']);
    expect(second.writes).toEqual([]);
  });
});
