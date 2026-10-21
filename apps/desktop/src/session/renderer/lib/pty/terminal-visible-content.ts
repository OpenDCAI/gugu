import type { Terminal } from '@xterm/xterm';

/**
 * 终端缓冲区里有没有**一个可见字符**。
 *
 * 这是「TUI 加载态什么时候可以撤」的唯一依据。
 *
 * ⚠️ 判据必须是「画面上有没有东西」，❌ 不能是「有没有字节到达」：
 * agent TUI 启动时最先发的是一串转义序列（查询设备属性、清屏、定位光标、切备用屏），
 * 那些是字节，画面上什么也没有。按「有字节」撤加载态 = 在纯转义序列那一刻就撤 =
 * 用户仍然面对一片空白 + 左上角一个闪烁光标（owner 实测报的正是这个症状）。
 *
 * `translateToString(true)` 会裁掉行尾空白，所以整屏空格读作空 —— 一个只画背景色、
 * 不画任何字形的 TUI 会被漏判，加载态多留一会。已知且可接受：漏判方向是「多等」，
 * 不是「提前撤」。
 *
 * ❗ 这个模块**刻意不 import 任何东西**（只有类型），这样测试可以单独加载它，
 * 不会把 ipc / app-state 那条链一起拉起来。
 */
export function terminalHasVisibleContent(terminal: Pick<Terminal, 'buffer'>): boolean {
  const buf = terminal.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line && line.translateToString(true).trim().length > 0) return true;
  }
  return false;
}
