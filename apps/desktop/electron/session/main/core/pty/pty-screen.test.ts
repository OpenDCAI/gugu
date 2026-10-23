import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { PtyScreen, SCREEN_SCROLLBACK_LINES } from './pty-screen';

const SIZE = { cols: 40, rows: 6 };
const opened: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
});

function screen(size = SIZE): PtyScreen {
  const s = new PtyScreen(size);
  opened.push(s);
  return s;
}

/** 一个之后才打开的视图:新终端,只喂给它 `data`。 */
async function viewOf(data: string, size = SIZE): Promise<Terminal> {
  const term = new Terminal({ ...size, scrollback: 10_000, allowProposedApi: true });
  opened.push(term);
  await new Promise<void>((r) => term.write(data, r));
  return term;
}

function rows(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++) out.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
  return out;
}

type Internals = { _core: { coreMouseService: { activeEncoding: string }; coreService: { isCursorHidden: boolean } } };
const internals = (term: Terminal) => (term as unknown as Internals)._core;

/** 全屏 TUI 的样子:启动时进备用屏、开鼠标(SGR 坐标)、括号粘贴、焦点上报、藏光标,之后只发差量重画。 */
function tuiStream(frames: number): string {
  let s = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l';
  s += '\x1b[1;1Htitle\x1b[6;1H> input';
  for (let i = 0; i < frames; i++) s += `\x1b[3;1Hstreaming ${i}\x1b[K`;
  return s;
}

describe('PtyScreen', () => {
  it('全屏 TUI 跑了很久之后才打开视图:快照恢复备用屏、鼠标与编码、括号粘贴、焦点上报、光标显隐和整屏内容', async () => {
    const stream = tuiStream(5000);
    expect(stream.length).toBeGreaterThan(64 * 1024);
    const source = await viewOf(stream);

    // 对照:从前回放的是最后 64KB 原始字节 —— 进备用屏那一句早被挤掉,视图停在普通缓冲区、没有鼠标。
    const tail = await viewOf(stream.slice(-64 * 1024));
    expect(tail.buffer.active.type).toBe('normal');
    expect(tail.modes.mouseTrackingMode).toBe('none');

    const s = screen();
    s.write(stream);
    const snapshot = await s.snapshot();
    expect(snapshot.size).toEqual(SIZE);
    const view = await viewOf(snapshot.data);
    expect(view.buffer.active.type).toBe('alternate');
    expect(view.modes.mouseTrackingMode).toBe('any');
    expect(internals(view).coreMouseService.activeEncoding).toBe('SGR');
    expect(view.modes.bracketedPasteMode).toBe(true);
    expect(view.modes.sendFocusMode).toBe(true);
    expect(internals(view).coreService.isCursorHidden).toBe(true);
    expect(rows(view)).toEqual(rows(source));
    expect(rows(view)[2]).toBe('streaming 4999');
  });

  it('SGR 像素坐标编码(?1016)也恢复', async () => {
    const s = screen();
    s.write('\x1b[?1003h\x1b[?1016h');
    const view = await viewOf((await s.snapshot()).data);
    expect(internals(view).coreMouseService.activeEncoding).toBe('SGR_PIXELS');
  });

  it(`普通缓冲区带最后 ${SCREEN_SCROLLBACK_LINES} 行回滚`, async () => {
    const s = screen();
    const total = SCREEN_SCROLLBACK_LINES + 500;
    for (let i = 1; i <= total; i++) s.write(`line ${i}\r\n`);
    const view = await viewOf((await s.snapshot()).data);
    const buffer = view.buffer.active;
    expect(buffer.type).toBe('normal');
    const all: string[] = [];
    for (let y = 0; y < buffer.length; y++) all.push(buffer.getLine(y)?.translateToString(true) ?? '');
    const numbered = all.filter((l) => l.startsWith('line '));
    expect(numbered.at(-1)).toBe(`line ${total}`);
    expect(numbered).toHaveLength(SCREEN_SCROLLBACK_LINES + SIZE.rows - 1);
  });

  it('rebuilds a 135-column view with all 10,000 original lines and output produced while closed', async () => {
    const size = { cols: 135, rows: 41 };
    const data = Array.from({ length: 10_000 }, (_, i) => `row-${i.toString().padStart(5, '0')} ${'x'.repeat(65)}\r\n`).join('');
    const s = screen(size);
    s.write(data);
    const before = await viewOf((await s.snapshot()).data, size);
    before.dispose();
    s.write('written while closed\r\n');
    const restored = await viewOf((await s.snapshot()).data, size);
    const lines = Array.from({ length: restored.buffer.active.length }, (_, i) => restored.buffer.active.getLine(i)?.translateToString(true) ?? '');
    expect(lines.filter((line) => line.startsWith('row-'))).toEqual(data.trimEnd().split('\r\n'));
    expect(lines).toContain('written while closed');
  });

  it('交接:要快照之后、切出来之前写进来的批次单独放在 live;切出来之后写的不在', async () => {
    const s = screen();
    s.write('A');
    const pending = s.snapshot();
    s.write('B');
    const snapshot = await pending;
    s.write('C');
    expect(rows(await viewOf(snapshot.data))[0]).toBe('A');
    expect(snapshot.live).toBe('B');
    expect(rows(await viewOf(snapshot.data + snapshot.live))[0]).toBe('AB');
  });

  it('切点落在半个转义序列上:前半截接在屏幕后面,后半截到了不会被当成字', async () => {
    const s = screen();
    s.write('A\x1b[3'); // PTY 一次只读到半个 SGR
    const snapshot = await s.snapshot();
    const view = await viewOf(snapshot.data + snapshot.live + '1mB');
    expect(rows(view)[0]).toBe('AB');
    expect(view.buffer.active.getLine(0)?.getCell(1)?.getFgColor()).toBe(1);
    // 对照:少了那半截,后半截就成了字。
    expect(rows(await viewOf('A' + '1mB'))[0]).toBe('A1mB');
  });

  it('解析停了(xterm 的写入循环被解析器异常打断)也不卡住接入:交空屏并照常给出之后的输出', async () => {
    const s = new PtyScreen(SIZE, 50);
    opened.push(s);
    // 让写入循环停住:异步处理器返回一个永不落定的 Promise,xterm 就一直等它 —— 与解析器抛错后
    // 写入循环再也不走(#4904)同一个外形,且不在测试里留下未捕获的异常。
    // 公开类型只写了 boolean;xterm 6 的解析器运行时接受 Promise(异步处理器)。
    const never = (() => new Promise<boolean>(() => {})) as unknown as () => boolean;
    (s as unknown as { terminal: Terminal }).terminal.parser.registerCsiHandler({ final: 'Z' }, never);
    s.write('before\x1b[Z');
    const pending = s.snapshot();
    s.write('after');
    const snapshot = await pending;
    expect(snapshot.data).toBe('');
    expect(snapshot.live).toBe('after');
    await expect(s.snapshot()).resolves.toEqual({ data: '', live: '', size: SIZE });
  });

  it('滚动区域(DECSTBM)与光标样式(DECSCUSR)也恢复,光标留在原处', async () => {
    const s = screen();
    s.write('\x1b[?1049h\x1b[2;5r\x1b[4 q\x1b[3;7Hx');
    const source = await viewOf('\x1b[?1049h\x1b[2;5r\x1b[4 q\x1b[3;7Hx');
    const view = await viewOf((await s.snapshot()).data);
    const core = (t: Terminal) => (t as unknown as { _core: { buffer: { scrollTop: number; scrollBottom: number; x: number; y: number }; coreService: { decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } } } })._core;
    for (const t of [source, view]) {
      expect([core(t).buffer.scrollTop, core(t).buffer.scrollBottom]).toEqual([1, 4]);
      expect([core(t).buffer.x, core(t).buffer.y]).toEqual([7, 2]);
      expect(core(t).coreService.decPrivateModes.cursorStyle).toBe('underline');
      expect(core(t).coreService.decPrivateModes.cursorBlink).toBe(false);
    }
  });

  it('改尺寸与输出同序:之前到的字节按旧网格解析', async () => {
    const s = screen({ cols: 20, rows: SIZE.rows });
    // 备用屏不重排:按 20 列写下的 30 个字折成 20 + 10;改到 40 列后仍是两行。顺序反了就是 40 列下的一整行。
    s.write(`\x1b[?1049h${'x'.repeat(30)}`);
    s.resize(40, SIZE.rows);
    const snapshot = await s.snapshot();
    expect(snapshot.size).toEqual({ cols: 40, rows: SIZE.rows });
    const view = await viewOf(snapshot.data, snapshot.size);
    expect(rows(view).slice(0, 2)).toEqual(['x'.repeat(20), 'x'.repeat(10)]);
  });

  it('DECRQM 查询(xterm 6.0 发布产物里会抛,#4904)不打断解析', async () => {
    const s = screen();
    s.write('\x1b[?2026$p\x1b[$pafter');
    expect(rows(await viewOf((await s.snapshot()).data))[0]).toBe('after');
  });

  it('dispose 时已经要了的快照照常切完(含最后几批);之后再要是空屏', async () => {
    const s = screen();
    s.write('last ');
    const pending = s.snapshot();
    s.write('words');
    s.dispose();
    const last = await pending;
    expect(rows(await viewOf(last.data + last.live))[0]).toBe('last words');
    await expect(s.snapshot()).resolves.toEqual({ data: '', live: '', size: SIZE });
  });
});
