import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { terminalHasVisibleContent } from '@renderer/lib/pty/terminal-visible-content';

// 这条判据是「TUI 加载态什么时候可以撤」的全部依据，所以它必须能**双向**分辨：
//   · 只来了转义序列（清屏 / 定位光标 / 查询设备属性）—— 画面上什么也没有 ⇒ 必须说「没有」
//   · 真的打出了字 ⇒ 必须说「有」
// ❌ 别把它换回「有字节到达就算」：agent TUI 启动时最先发的恰恰是那串转义序列，
//    按字节判 = 在纯转义序列那一刻就撤加载态 = 用户仍然面对空白 + 闪烁光标（owner 实测的原始症状）。

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, () => resolve()));

describe('terminalHasVisibleContent', () => {
  it('刚建好的空终端：没有可见内容', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    expect(terminalHasVisibleContent(term)).toBe(false);
    term.dispose();
  });

  it('【关键】只来了转义序列 —— 字节到了，但画面上什么都没有 ⇒ 必须说「没有」', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    // agent TUI 启动握手的典型形状：查询设备属性、清屏、归位、设置模式
    await write(term, '\x1b[c\x1b[2J\x1b[H\x1b[?25l\x1b[?1049h\x1b[?2004h');
    expect(
      terminalHasVisibleContent(term),
      '纯转义序列被当成了「有内容」—— 加载态会提前撤，用户仍然看到空白+光标'
    ).toBe(false);
    term.dispose();
  });

  it('整屏空格也不算「有内容」', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    await write(term, ' '.repeat(200));
    expect(terminalHasVisibleContent(term)).toBe(false);
    term.dispose();
  });

  it('真的打出了字 ⇒ 说「有」', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    await write(term, 'Claude Code v2.1.259');
    expect(terminalHasVisibleContent(term)).toBe(true);
    term.dispose();
  });

  it('先转义序列再真内容 ⇒ 只在真内容到达后才说「有」（这就是真实的启动顺序）', async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    await write(term, '\x1b[2J\x1b[H');
    expect(terminalHasVisibleContent(term)).toBe(false);
    await write(term, '你好');
    expect(terminalHasVisibleContent(term)).toBe(true);
    term.dispose();
  });
});
