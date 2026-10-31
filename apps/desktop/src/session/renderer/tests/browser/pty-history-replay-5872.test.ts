import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

describe('FrontendPty history replay (#5872)', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let liveDataListener: ((data: string) => void) | null;
  let subscribeData: { buffer: string; live?: string; size: { cols: number; rows: number } | null };

  beforeEach(() => {
    liveDataListener = null;
    // A Codex startup transcript contains these terminal queries.
    subscribeData = { buffer: '\x1b]10;?\x07\x1b]11;?\x07\x1b[c', size: null };
    invoke = vi.fn((channel: string) => {
      if (channel === 'pty.subscribe') {
        return Promise.resolve({ success: true, data: subscribeData });
      }
      return Promise.resolve({ success: true, data: {} });
    });
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn((channel: string, callback: (data: unknown) => void) => {
        if (!channel.startsWith('pty:data.')) return () => {};
        liveDataListener = callback as (data: string) => void;
        return () => { liveDataListener = null; };
      }),
      eventSend: vi.fn(),
      invoke,
    });

    for (const [name, value] of [
      ['--xterm-bg', '#ffffff'],
      ['--xterm-fg', '#171717'],
      ['--xterm-cursor', '#171717'],
      ['--xterm-cursor-accent', '#ffffff'],
      ['--xterm-selection-bg', '#cce0ff'],
      ['--xterm-selection-fg', '#000000'],
    ]) {
      document.documentElement.style.setProperty(name, value);
    }
  });

  afterEach(async () => {
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    document.querySelectorAll('[data-replay-live-target]').forEach(element => element.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountVisible(pty: { mount(target: HTMLDivElement): void }) {
    const target = document.createElement('div');
    target.setAttribute('data-replay-live-target', '');
    target.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:300px';
    document.body.appendChild(target);
    pty.mount(target);
  }

  const sentInputs = () =>
    invoke.mock.calls
      .filter(([channel]) => channel === 'pty.sendInput')
      .map(([, , data]) => String(data));

  it('does not recreate a data listener when a closed view receives its pending subscription', async () => {
    let reply!: (value: unknown) => void;
    invoke.mockImplementation((channel: string) => channel === 'pty.subscribe'
      ? new Promise((resolve) => { reply = resolve; })
      : Promise.resolve({ success: true, data: {} }));
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('closed-before-subscribe');
    const write = vi.spyOn(pty.terminal, 'write');
    const pending = pty.connect();
    pty.dispose();
    reply({ success: true, data: subscribeData });
    await pending;
    expect(liveDataListener).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(FrontendPty.all.has(pty)).toBe(false);
    expect(pty.ownedContainer.isConnected).toBe(false);
  });

  it('does not write the buffered live tail after the view closes during replay', async () => {
    subscribeData = { buffer: 'history', live: 'live tail', size: null };
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('closed-during-replay');
    let parsed: (() => void) | undefined;
    const write = vi.spyOn(pty.terminal, 'write').mockImplementation((_data, callback) => { parsed = callback; });
    const pending = pty.connect();
    await until('history write is pending', () => parsed !== undefined);
    pty.dispose();
    const errors = vi.spyOn(console, 'error');
    parsed?.();
    await pending;
    expect(errors).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(FrontendPty.all.has(pty)).toBe(false);
  });

  it('does not send terminal replies generated while replaying history', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('history-replay');
    mountVisible(pty);

    await pty.connect();
    // @@@replay-drained - 「回放期间没回话」要等到回放之后的输出也被 xterm 处理完才判得了。
    // xterm 按写入顺序解析,于是回放之后再喂一条实时的光标位置查询(CSI 6n),它的回话(CSI r;c R)
    // 一出现,回放那段字节触发的回话就已经全部发出(或被拦下)了 —— 等的是这个事实,❌ 不是睡 250ms。
    expect(liveDataListener).toBeTypeOf('function');
    liveDataListener?.('\x1b[6n');
    await until('live cursor-position reply sent after the replay', () =>
      sentInputs().some((data) => /^\x1b\[\d+;\d+R$/.test(data))
    );

    const sent = sentInputs();
    expect(sent.some((data) => data.includes(']10;rgb:'))).toBe(false);
    expect(sent.some((data) => data.includes(']11;rgb:'))).toBe(false);
    expect(sent.some((data) => data.includes('[?1;2c'))).toBe(false);
  });

  it('still forwards replies generated by live PTY output', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('live-output');
    mountVisible(pty);

    await pty.connect();
    expect(liveDataListener).toBeTypeOf('function');
    liveDataListener?.('\x1b]10;?\x07');
    await until('live OSC 10 reply sent', () => sentInputs().some((data) => data.includes(']10;rgb:')));

    const sent = sentInputs();
    expect(sent).toContain('\x1b]10;rgb:1717/1717/1717\x1b\\');
  });

  it('answers queries in the output that arrived while the snapshot was cut, not those in the snapshot', async () => {
    // `live` = 主进程要快照之后才到的输出(pty-screen.ts):是新输出,TUI 正等着回话;`buffer` 是旧画面。
    subscribeData = { buffer: '\x1b]10;?\x07', live: '\x1b]11;?\x07', size: null };
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('snapshot-live-tail');

    await pty.connect();
    await until('OSC 11 reply for the live tail', () => sentInputs().some((data) => data.includes(']11;rgb:')));

    expect(sentInputs().some((data) => data.includes(']10;rgb:'))).toBe(false);
  });

  it('replays history on the grid the PTY drew it for', async () => {
    // TUI 按绝对坐标落字:第 140 列、第 38 行。在占位的 120×32 上回放会被夹到边上,事后再改网格
    // 也挪不回来(❌ 用一整行长字符串:xterm 放宽时会把折行无损拼回去,分不出先后)。
    subscribeData = { buffer: '\x1b[1;140HZ\x1b[38;1HY', size: { cols: 150, rows: 40 } };
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('history-replay-grid');

    await pty.connect();

    expect([pty.terminal.cols, pty.terminal.rows]).toEqual([150, 40]);
    const buffer = pty.terminal.buffer.active;
    expect(buffer.getLine(buffer.baseY)?.translateToString(false).indexOf('Z')).toBe(139);
    expect(buffer.getLine(buffer.baseY + 37)?.translateToString(true)).toBe('Y');
  });

  it('keeps a freshly connected terminal transparent until xterm has painted it once', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('offscreen-stale-dom');
    await pty.connect(); // 历史在离屏宿主里解析,那时渲染是暂停的
    const target = document.createElement('div');
    Object.assign(target.style, { width: '800px', height: '400px' });
    document.body.appendChild(target);
    try {
      pty.mount(target);
      expect(pty.ownedContainer.style.opacity).toBe('0');
      await until('revealed after a full repaint', () => pty.ownedContainer.style.opacity === '');

      // 再挂:停着的行 DOM 就是用户上次看到的画面,直接露出来(暖切换不多一帧空白)。
      pty.unmount();
      await new Promise<void>((resolve) => pty.terminal.write('output while away', resolve));
      pty.mount(target);
      expect(pty.ownedContainer.style.opacity).toBe('');
    } finally {
      target.remove();
    }
  });

  it('ends a stuck history write and flushes live output', async () => {
    const { FrontendPty, HISTORY_REPLAY_WRITE_TIMEOUT_MS } = await getPtyModule();
    const pty = new FrontendPty('history-replay-timeout');
    const write = vi.spyOn(pty.terminal, 'write').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const connectPromise = pty.connect();
      let connectResolved = false;
      void connectPromise.then(() => {
        connectResolved = true;
      });

      await Promise.resolve();
      expect(liveDataListener).toBeTypeOf('function');
      liveDataListener?.('live-after-stuck-replay');

      await vi.advanceTimersByTimeAsync(HISTORY_REPLAY_WRITE_TIMEOUT_MS);
      await Promise.resolve();
      expect(connectResolved).toBe(true);
      await expect(connectPromise).resolves.toBeUndefined();

      expect((pty as unknown as { replayingHistory: boolean }).replayingHistory).toBe(false);
      expect(write).toHaveBeenCalledWith('live-after-stuck-replay', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
});
