import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { forgetPtyOutput, ptyOutputActivity, recordPtyOutput } from '@main/core/pty/pty-output-activity';
import type { Session } from '@shared/core/sessions/sessions';
import {
  injectSessionMessageWhenReady,
  injectSystemBootstrapWhenReady,
  planSystemBootstrap,
  setPtyStartupGate,
} from './keystroke-injection';

function session(providerId: Session['providerId']): Session {
  return {
    id: 'conv-1',
    projectId: 'proj-1',
    providerId,
    title: '',
    lastInteractedAt: null,
  };
}

function ptyDouble() {
  const write = vi.fn();
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((info: PtyExitInfo) => void) | undefined;
  const pty = {
    write,
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (handler: (data: string) => void) => { dataHandler = handler; },
    onExit: (handler: (info: PtyExitInfo) => void) => { exitHandler = handler; },
  } as unknown as Pty;
  return {
    pty,
    write,
    emitData: (data: string) => dataHandler?.(data),
    emitExit: () => exitHandler?.({ exitCode: 0, signal: undefined }),
  };
}

describe('injectSessionMessageWhenReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('accepts an ordinary message after the TUI becomes quiet', async () => {
    const target = ptyDouble();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm1', text: 'Fix the bug' },
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm1' });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('Fix the bug\r');
  });

  it('uses native PTY control for argv-capable providers after startup too', async () => {
    const target = ptyDouble();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm2', text: 'later message' },
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm2' });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('later message\r');
  });

  it('writes an ordinary message immediately while the PTY is active', async () => {
    const target = ptyDouble();
    const bootstrap = injectSystemBootstrapWhenReady({
      pty: target.pty,
      session: session('opencode'),
      text: 'system bootstrap',
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(bootstrap).resolves.toBeUndefined();
    target.write.mockClear();

    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-immediate', text: 'mid-turn message' },
    });

    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm-immediate' });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('mid-turn message\r');
  });

  it('clears one-time readiness when the PTY exits', async () => {
    const target = ptyDouble();
    const bootstrap = injectSystemBootstrapWhenReady({
      pty: target.pty,
      session: session('opencode'),
      text: 'system bootstrap',
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(bootstrap).resolves.toBeUndefined();
    target.write.mockClear();

    await expect(injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-before-exit', text: 'direct before exit' },
    })).resolves.toEqual({ status: 'accepted', messageId: 'm-before-exit' });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('direct before exit\r');

    target.emitExit();
    const afterExit = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-after-exit', text: 'new PTY message' },
    });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('direct before exit\r');
    target.emitData('new PTY output');
    await vi.advanceTimersByTimeAsync(900);
    await expect(afterExit).resolves.toEqual({ status: 'accepted', messageId: 'm-after-exit' });
    expect(target.write).toHaveBeenCalledWith('new PTY message\r');
  });

  it('inherits the bounded max-wait readiness decision only once', async () => {
    const target = ptyDouble();
    const first = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-max-wait', text: 'first message' },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toEqual({ status: 'accepted', messageId: 'm-max-wait' });
    target.write.mockClear();

    const second = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-after-max-wait', text: 'second message' },
    });
    await expect(second).resolves.toEqual({ status: 'accepted', messageId: 'm-after-max-wait' });
    expect(target.write).toHaveBeenCalledExactlyOnceWith('second message\r');
  });

  it('keeps multiline input as one bracketed-paste command', async () => {
    const target = ptyDouble();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm3', text: 'line one\nline two' },
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm3' });
    expect(target.write).toHaveBeenCalledWith('\x1b[200~line one\nline two\x1b[201~\r');
  });

  it('writes Kimi keystrokes one character at a time before the separated CR submit', async () => {
    const target = ptyDouble();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('kimi'),
      message: { id: 'm-kimi', text: 'marker' },
    });
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(849);
    expect(target.write.mock.calls.every(([value]) => typeof value === 'string' && value.length <= 1)).toBe(true);
    expect(target.write.mock.calls.at(-1)?.[0]).not.toBe('\r');
    expect(target.write.mock.calls.length).toBeGreaterThan(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.write.mock.calls.at(-1)?.[0]).toBe('\r');
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm-kimi' });
  });

  // ── #5558 就绪闸读的是事实,不是「有没有人注入过」 ───────────────────────────────
  //
  // 这三格钉的是同一件事的三个分支。⚠️ 三格在**旧行为下都会红**(旧代码只在收到 `onData` 之后才装
  // 静默臂,所以对一条「已经静了」的 PTY 只能等满 MAX_WAIT_MS=15_000):
  //  · 第一格:不推进时间就断言已写出 —— 旧行为下 0 次写;
  //  · 第二格:300ms 就该写 —— 旧行为下要 15_000ms;
  //  · 第三格:反向 —— 事实缺席时**不许**抢跑(它保证前两格不是靠「一律立刻写」蒙过的)。

  it('injects at once when the registry already saw this PTY produce output and go quiet', async () => {
    const target = ptyDouble();
    // 事实的写入者是 registry 那个 onData;这里直接写它,模拟「TUI 早就画完、正停在输入框等输入」
    // —— 用户从聊天页发第一条 DM 时最常见的状态(#5558 实测 pi 15 348ms / copilot 15 314ms)。
    recordPtyOutput(target.pty, Date.now() - 60_000);
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-settled', text: 'from the chat page' },
    });
    // ⚠️ 一格时间都不推进:旧行为下这里必须是 0 次写。
    expect(target.write).toHaveBeenCalledExactlyOnceWith('from the chat page\r');
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm-settled' });
  });

  it('finishes the quiet window the PTY already started instead of waiting for another byte', async () => {
    const target = ptyDouble();
    // 500ms 前出过字,而**那就是最后一个字节** ⇒ 再也不会有 onData 来装静默臂。
    recordPtyOutput(target.pty, Date.now() - 500);
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-partial', text: 'mid startup' },
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(target.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);            // 800 - 500 = 300ms,补差的那一段
    expect(target.write).toHaveBeenCalledExactlyOnceWith('mid startup\r');
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm-partial' });
  });

  it('still waits for the first byte when the PTY has produced no output at all', async () => {
    const target = ptyDouble();
    forgetPtyOutput(target.pty);
    expect(ptyOutputActivity(target.pty)).toBeNull();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm-silent', text: 'before any frame' },
    });
    // 事实缺席 = 这条 PTY 一个字节都没出过 ⇒ ❌ 不许抢跑到一个还没画出输入框的 TUI 里。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(target.write).not.toHaveBeenCalled();
    target.emitData('ready');
    await vi.advanceTimersByTimeAsync(800);
    expect(target.write).toHaveBeenCalledExactlyOnceWith('before any frame\r');
    await expect(accepted).resolves.toEqual({ status: 'accepted', messageId: 'm-silent' });
  });

  it('returns an explicit rejection when the PTY exits before accepting any bytes', async () => {
    const target = ptyDouble();
    const accepted = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm4', text: 'still pending' },
    });
    target.emitExit();
    await expect(accepted).resolves.toEqual({ status: 'not-ready' });
    expect(target.write).not.toHaveBeenCalled();

    const retry = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('opencode'),
      message: { id: 'm4-retry', text: 'retry after replacement' },
    });
    expect(target.write).not.toHaveBeenCalled();
    target.emitData('replacement ready');
    await vi.advanceTimersByTimeAsync(900);
    await expect(retry).resolves.toEqual({ status: 'accepted', messageId: 'm4-retry' });
  });
});

describe('planSystemBootstrap', () => {
  it.each(['argv', 'stdin-pipe'] as const)('%s gives system bytes only to buildCommand', (transport) => {
    expect(planSystemBootstrap('system bytes', transport)).toEqual({ commandText: 'system bytes' });
  });

  it('gives keystroke system bytes only to the runtime-ready injector', () => {
    expect(planSystemBootstrap('system bytes', 'keystroke')).toEqual({ readyText: 'system bytes' });
  });

  it('fails loud when system bytes have no declared transport', () => {
    expect(() => planSystemBootstrap('system bytes', 'none'))
      .toThrow('system bootstrap requires a declared prompt transport');
  });

  it('does not create either owner for empty bootstrap', () => {
    expect(planSystemBootstrap('  ', 'none')).toEqual({});
  });
});

describe('startup gate(首句走 local-session 的家:门开之前写进 pty 的一切都等着)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function multiExitPty() {
    const write = vi.fn();
    const exits: Array<(info: PtyExitInfo) => void> = [];
    const pty = {
      write,
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (handler: (info: PtyExitInfo) => void) => { exits.push(handler); },
    } as unknown as Pty;
    return { pty, write, exit: () => { for (const handler of exits) handler({ exitCode: 0, signal: undefined }); } };
  }

  it('holds messages until the host opens the gate, then injects them in order', async () => {
    const target = multiExitPty();
    // 输出活动早已静下来 ⇒ 没有门时会立刻写;有门就得等门。
    recordPtyOutput(target.pty);
    await vi.advanceTimersByTimeAsync(1_000);
    let open!: () => void;
    setPtyStartupGate(target.pty, new Promise<void>((resolve) => { open = resolve; }));
    const first = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('antigravity'),
      message: { id: 'm1', text: 'first turn' },
    });
    const second = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('antigravity'),
      message: { id: 'm2', text: 'queued' },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(target.write).not.toHaveBeenCalled();
    open();
    await expect(first).resolves.toEqual({ status: 'accepted', messageId: 'm1' });
    await expect(second).resolves.toEqual({ status: 'accepted', messageId: 'm2' });
    expect(target.write.mock.calls.map(([data]) => data)).toEqual(['first turn\r', 'queued\r']);
    forgetPtyOutput(target.pty);
  });

  it('answers not-ready when the process exits before the gate opens', async () => {
    const target = multiExitPty();
    setPtyStartupGate(target.pty, new Promise<void>(() => {}));
    const pending = injectSessionMessageWhenReady({
      pty: target.pty,
      session: session('antigravity'),
      message: { id: 'm1', text: 'first turn' },
    });
    target.exit();
    await expect(pending).resolves.toEqual({ status: 'not-ready' });
    expect(target.write).not.toHaveBeenCalled();
  });
});
