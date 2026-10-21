import '@xterm/xterm/css/xterm.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';

// #6547:编程模式里光标停在输入框右边缘时打拼音 —— 拼音浮层不换行地伸出去,挂终端那一层被浏览器横向滚走。
// 组合态经 CDP `Input.imeSetComposition` 造,与真输入法走同一条路(浏览器插入组合文字 → compositionupdate
// → 为露出输入光标滚动祖先),合成的 CompositionEvent 走不到滚动那一步。

type Cdp = { send: (method: string, params: object) => Promise<unknown> };
const session = () => cdp() as unknown as Cdp;
const ESC = '\x1b';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

/** 产品的挂载位:固定宽高、overflow 取产品用的那个值(对照格传 hidden)。 */
function makeSlot(overflow: string): HTMLDivElement {
  const slot = document.createElement('div');
  Object.assign(slot.style, { position: 'absolute', left: '0', top: '0', width: '360px', height: '240px', overflow });
  document.body.appendChild(slot);
  return slot;
}

/** 从 el 往上到根,凡是被滚过的都列出来(输入框自己的内部滚动除外 —— 它透明,滚了也看不见)。 */
function scrolledAncestors(el: Element): string[] {
  const out: string[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.scrollLeft !== 0 || n.scrollTop !== 0) out.push(`${n.tagName}.${n.className}:${n.scrollLeft},${n.scrollTop}`);
  }
  return out;
}

async function compose(text: string) {
  await session().send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
}

describe('IME composition at the right edge of a TUI prompt (#6547)', () => {
  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ success: true, data: { buffer: '', size: null } })),
    });
  });

  afterEach(async () => {
    try {
      await session().send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    } catch {}
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 挂一个终端,网格铺满挂载位,写一行把光标推到 `cursorCol`(0 起),聚焦。 */
  async function mountPrompt(overflow: string, opts: { lastRow?: boolean; cursorCol?: (cols: number) => number } = {}) {
    const { FrontendPty, TERMINAL_PADDING_PX } = await getPtyModule();
    const { getCellMetrics } = await import('@renderer/lib/pty/xterm-cell-metrics');
    const slot = makeSlot(overflow);
    const pty = new FrontendPty(`ime-edge-${Math.random()}`);
    pty.mount(slot);
    const term = pty.terminal;
    await until('xterm measured its cell', () => getCellMetrics(term) !== null);
    const cell = getCellMetrics(term)!;
    const cols = Math.floor((360 - 2 * TERMINAL_PADDING_PX) / cell.width);
    const rows = Math.floor((240 - 2 * TERMINAL_PADDING_PX) / cell.height);
    term.resize(cols, rows);
    const row = opts.lastRow ? rows : 2; // 1 起
    const col = opts.cursorCol ? opts.cursorCol(cols) : cols - 2;
    await new Promise<void>((resolve) =>
      term.write(`${ESC}[2J${ESC}[${row};1H> ${'a'.repeat(cols - 3)}${ESC}[${row};${col + 1}H`, resolve)
    );
    term.focus();
    const textarea = term.textarea!;
    await until('terminal textarea focused', () => document.activeElement === textarea);
    const view = term.element!.querySelector<HTMLElement>('.composition-view')!;
    const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!;
    /** 浮层相对网格的位置,单位是格。 */
    const where = () => {
      const s = screen.getBoundingClientRect();
      const v = view.getBoundingClientRect();
      const t = textarea.getBoundingClientRect();
      return {
        col: Math.round((v.left - s.left) / cell.width),
        row: Math.round((v.top - s.top) / cell.height),
        overhangPx: v.right - (s.left + cols * cell.width),
        textareaWithView: Math.abs(t.left - v.left) < 0.5 && Math.abs(t.top - v.top) < 0.5,
      };
    };
    return { slot, term, textarea, view, where, cols, rows, row: row - 1, col };
  }

  it('control: a focused textarea poking out of an overflow:hidden box gets that box scrolled by the IME', async () => {
    // 这一格证明仪器看得见「被滚走」:不经 xterm,一个伸出右边缘的输入框,组合时浏览器就会滚它的祖先。
    const slot = makeSlot('hidden');
    const input = document.createElement('textarea');
    Object.assign(input.style, { position: 'absolute', left: '340px', top: '10px', width: '120px', height: '20px' });
    slot.appendChild(input);
    input.focus();
    await compose('nihaoshijie');
    await until('IME text reached the textarea', () => input.value.includes('nihaoshijie'));
    expect(slot.scrollLeft).toBeGreaterThan(0);
  });

  it('keeps the pinyin inside the grid: moves it to the start of the next row, textarea follows', async () => {
    const { TERMINAL_CONTAINER_OVERFLOW } = await getPtyModule();
    const t = await mountPrompt(TERMINAL_CONTAINER_OVERFLOW);
    await compose('nihaoshijie');
    await until('composition view shows the pinyin', () => t.view.textContent === 'nihaoshijie');
    await new Promise((resolve) => setTimeout(resolve, 0)); // xterm 在其后一个 tick 还会再摆一次
    expect(t.where()).toMatchObject({ col: 0, row: t.row + 1, textareaWithView: true });
    expect(t.where().overhangPx).toBeLessThanOrEqual(0);
    expect(scrolledAncestors(t.textarea)).toEqual([]);

    await session().send('Input.insertText', { text: '你好世界' });
    await until('composition committed', () => !t.view.classList.contains('active'));
    expect(scrolledAncestors(t.textarea)).toEqual([]);
  });

  it('on the last row there is no next row: the pinyin ends flush with the right edge instead', async () => {
    const { TERMINAL_CONTAINER_OVERFLOW } = await getPtyModule();
    const t = await mountPrompt(TERMINAL_CONTAINER_OVERFLOW, { lastRow: true });
    await compose('nihaoshijie');
    await until('composition view shows the pinyin', () => t.view.textContent === 'nihaoshijie');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const at = t.where();
    expect(at).toMatchObject({ row: t.row, col: t.cols - 'nihaoshijie'.length, textareaWithView: true });
    expect(Math.abs(at.overhangPx)).toBeLessThan(1);
  });

  it('leaves the pinyin at the cursor when it fits', async () => {
    const { TERMINAL_CONTAINER_OVERFLOW } = await getPtyModule();
    const t = await mountPrompt(TERMINAL_CONTAINER_OVERFLOW, { cursorCol: () => 10 });
    await compose('nihao');
    await until('composition view shows the pinyin', () => t.view.textContent === 'nihao');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.where()).toMatchObject({ col: 10, row: t.row, textareaWithView: true });
  });

  it('a composition longer than a whole row still cannot scroll the terminal slot', async () => {
    // 整句输入法的组合串可以比一整行还长:挪到行首也伸得出去。这一格只由挂载位的 overflow 兜住 ——
    // 同一操作在 hidden 上会滚(下一条对照),在产品的取值上不滚。
    const { TERMINAL_CONTAINER_OVERFLOW } = await getPtyModule();
    const long = 'woshiyigezhongguoren'.repeat(4);
    const t = await mountPrompt(TERMINAL_CONTAINER_OVERFLOW);
    await compose(long);
    await until('composition view shows the long pinyin', () => t.view.textContent === long);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.where().overhangPx).toBeGreaterThan(0); // 前提:确实伸出去了
    expect(scrolledAncestors(t.textarea)).toEqual([]);
  });

  it('control: the same long composition on an overflow:hidden slot does scroll it', async () => {
    const long = 'woshiyigezhongguoren'.repeat(4);
    const t = await mountPrompt('hidden');
    await compose(long);
    await until('composition view shows the long pinyin', () => t.view.textContent === long);
    await until('slot scrolled', () => t.slot.scrollLeft > 0);
  });
});
