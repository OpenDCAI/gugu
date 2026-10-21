import type { Terminal } from '@xterm/xterm';
import { getCellMetrics } from './xterm-cell-metrics';

/**
 * @@@ime-edge (#6547) — 输入法组合时,xterm 把拼音浮层 `.composition-view`(`white-space: nowrap`)
 * 和有焦点的 helper textarea 画在光标处、一路往右。光标停在右边缘时整段伸出网格:
 * 浮层不换行地「往右推出去」,等选词上屏、TUI 自己折行后才落到下一行。
 * (整屏被横向滚走是另一半,由挂终端那层的 `overflow: clip` 挡住,见 pty-pane.tsx。)
 *
 * 放不下就挪到下一行行首 —— 与换行后字会落的位置一致;textarea 跟着走,系统候选窗随之落在
 * 浮层下方。光标在最后一行、下面没有行时退为贴右边缘。
 *
 * 位置只按光标算,❌ 按浮层当前的 left/top 算:xterm 在 compositionupdate、其后一个 tick、每次
 * 渲染都会把两者写回光标处,这里跟在它后面改;按当前值算,挪过一次的位置会被当成起点再挪一行。
 *
 * 浮层的字是浏览器按字体原宽排的,网格的格宽却随渲染器:DOM 渲染器就是字体原宽,WebGL 把它取整到
 * 设备像素(7.8 → 7px,@@@webgl-while-mounted)。不补的话浮层里每个字比网格宽出一截 —— 拼音对不上格,
 * 贴右边缘时起点落在半格上,看着像错了一格。⇒ 浮层的字距补到格宽(xterm 的 DOM 渲染器给行设
 * letter-spacing 也是同一个办法);DOM 渲染器下补的量是 0。
 */
export function placeCompositionInsideGrid(p: {
  cursorLeft: number;
  cursorTop: number;
  width: number;
  cellHeight: number;
  gridWidth: number;
  gridHeight: number;
}): { left: number; top: number } {
  if (p.cursorLeft + p.width <= p.gridWidth) return { left: p.cursorLeft, top: p.cursorTop };
  const nextTop = p.cursorTop + p.cellHeight;
  if (nextTop + p.cellHeight <= p.gridHeight) return { left: 0, top: nextTop };
  return { left: Math.max(0, p.gridWidth - p.width), top: p.cursorTop };
}

let measureContext: CanvasRenderingContext2D | null = null;

/** 这个字体下一个半角字的原宽(与 xterm 量字宽的办法相同:32 个 W 取平均)。 */
function fontAdvance(terminal: Terminal): number {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) throw new Error('composition-fit: no 2D canvas context to measure the font');
  measureContext.font = `${terminal.options.fontSize}px ${terminal.options.fontFamily}`;
  return measureContext.measureText('W'.repeat(32)).width / 32;
}

export function keepCompositionInsideGrid(terminal: Terminal): { dispose(): void } {
  const view = terminal.element?.querySelector<HTMLElement>('.composition-view');
  const textarea = terminal.textarea;
  if (!view || !textarea) return { dispose() {} };

  const fit = () => {
    if (!view.classList.contains('active')) return;
    const cell = getCellMetrics(terminal);
    if (!cell) return;
    const buffer = terminal.buffer.active;
    // 往上翻着历史时光标不在视口里,xterm 自己也不摆浮层(isCursorInViewport),这里同样不动。
    if (buffer.viewportY !== buffer.baseY) return;
    const spacing = cell.width - fontAdvance(terminal);
    // 同值不重写(写入本身又会喂给下面的观察者);读回的字符串会被浏览器规整,所以按数比。
    if (Math.abs((parseFloat(view.style.letterSpacing) || 0) - spacing) > 0.001) {
      view.style.letterSpacing = `${spacing}px`;
    }
    const place = placeCompositionInsideGrid({
      cursorLeft: Math.min(buffer.cursorX, terminal.cols - 1) * cell.width,
      cursorTop: buffer.cursorY * cell.height,
      width: view.getBoundingClientRect().width,
      cellHeight: cell.height,
      gridWidth: terminal.cols * cell.width,
      gridHeight: terminal.rows * cell.height,
    });
    const left = `${place.left}px`;
    const top = `${place.top}px`;
    // 只在值真的变了时写:写入本身又是一次 style 变更,同值重写会让观察者自己喂自己。
    for (const el of [view, textarea]) {
      if (el.style.left !== left) el.style.left = left;
      if (el.style.top !== top) el.style.top = top;
    }
  };

  // xterm 写位置的三处(compositionupdate、其后的 setTimeout、onRender)都落在这两个元素的 style 上;
  // 观察者在同一轮微任务里跟上,赶在下一次绘制之前。
  const observer = new MutationObserver(fit);
  observer.observe(view, { attributes: true, attributeFilter: ['style', 'class'], childList: true, characterData: true, subtree: true });
  observer.observe(textarea, { attributes: true, attributeFilter: ['style'] });
  return { dispose: () => observer.disconnect() };
}
