import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { events } from '@main/lib/events';
import type { Pty, PtyExitInfo } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));

const SIZE = { cols: 40, rows: 5 };

function fakePty() {
  let onData: (d: string) => void = () => {};
  let onExit: (i: PtyExitInfo) => void = () => {};
  const pty: Pty & { out(d: string): void; exit(i: PtyExitInfo): void } = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (h) => (onData = h),
    onExit: (h) => (onExit = h),
    out: (d) => onData(d),
    exit: (i) => onExit(i),
  };
  return pty;
}

/** 等这一拍的批次刷出去(注册表 16ms 攒一批)。靠定时器到期的先后,❌ 读墙钟。 */
const settle = () => new Promise<void>((r) => setTimeout(r, 25));

describe('PtySessionRegistry.subscribe', () => {
  it('后打开的视图拿到的是屏幕与模式,❌ 一段字节尾巴:全屏 TUI 早早进的备用屏照样还在', async () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: SIZE });
    pty.out('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h');
    // 远超从前 64KB 的差量重画(约 100KB)。
    for (let i = 0; i < 5000; i++) pty.out(`\x1b[1;1Hframe ${i}\x1b[K`);
    await settle();
    const { buffer, size } = await registry.subscribe('p:t:c');
    expect(size).toEqual(SIZE);
    const term = new Terminal({ ...SIZE, allowProposedApi: true });
    await new Promise<void>((r) => term.write(buffer, r));
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.modes.mouseTrackingMode).toBe('any');
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('frame 4999');
    term.dispose();
  });

  it('改尺寸与输出同序:快照报的是屏幕此刻的网格', async () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: SIZE });
    pty.out('x');
    registry.resize('p:t:c', 60, 8);
    await settle();
    expect((await registry.subscribe('p:t:c')).size).toEqual({ cols: 60, rows: 8 });
    expect(pty.resize).toHaveBeenCalledWith(60, 8);
  });

  it('还没起 PTY 的会话:空快照,网格是渲染层最后要过的那个', async () => {
    const registry = new PtySessionRegistry();
    registry.resize('p:t:c', 100, 30);
    await expect(registry.subscribe('p:t:c')).resolves.toEqual({ buffer: '', live: '', size: { cols: 100, rows: 30 } });
  });

  it('等快照时 agent 重启(同一个 id 重新登记):交的是新一代的屏幕,新一代最先那几句一个不漏', async () => {
    const registry = new PtySessionRegistry();
    const first = fakePty();
    registry.register('p:t:c', first, { size: SIZE });
    first.out('old generation');
    await settle();
    const pending = registry.subscribe('p:t:c');
    const second = fakePty();
    registry.register('p:t:c', second, { size: SIZE });
    second.out('\x1b[?1049hnew generation');
    const { buffer, live } = await pending;
    // 视图在应答之后才挂上监听:它拿到的是快照 + live + 之后才发出的批次。新一代那句不论落在哪一段,恰好出现一次。
    const emitted = vi.mocked(events.emit).mock.calls.length;
    await settle();
    const later = vi
      .mocked(events.emit)
      .mock.calls.slice(emitted)
      .filter(([, data, id]) => id === 'p:t:c' && typeof data === 'string')
      .map(([, data]) => data as string);
    const term = new Terminal({ ...SIZE, allowProposedApi: true });
    await new Promise<void>((r) => term.write(buffer + live + later.join(''), r));
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('new generation');
    term.dispose();
  });

  it('改尺寸之前先把攒着没刷的那批刷进屏幕:它们是按旧网格画的', async () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('p:t:c', pty, { size: { cols: 20, rows: 5 } });
    // 备用屏不重排:按 20 列写下的 30 个字折成 20 + 10;改到 40 列后仍是两行。先改网格再解析就成了一整行。
    // 第一块空闲后立刻刷出;同一拍里跟着到的这 30 个字还攒着。
    pty.out('\x1b[?1049h');
    pty.out('x'.repeat(30));
    registry.resize('p:t:c', 40, 5);
    await settle();
    const { buffer, size } = await registry.subscribe('p:t:c');
    expect(size).toEqual({ cols: 40, rows: 5 });
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await new Promise<void>((r) => term.write(buffer, r));
    expect([0, 1].map((y) => term.buffer.active.getLine(y)?.translateToString(true))).toEqual(['x'.repeat(20), 'x'.repeat(10)]);
    term.dispose();
  });
});
