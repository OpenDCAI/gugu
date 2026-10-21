import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings';

/**
 * @@@terminal-cjk-cell (#5586) — 自托管字体到位之后,**必须重新量一次格子**。
 *
 * 终端按格子排版,每个字形该占几格是量出来的:xterm 的 DOM 渲染器先问 WidthCache
 * 「这个字多宽」,再给那一格补一条 `letter-spacing = 应占宽 - 量到的宽` 抹平亚像素误差。
 * `Sarasa Mono SC` 是随包走的 woff2,加载是异步的 —— 中文标点在它落地**之前**被量到的是
 * 苹方的 8.667px(苹方的标点是比例宽,不是全角),缓存记下这个数;字体到位后真正画出来的
 * 是 15.6px,那条按 8.667 算出来的补偿却还挂着,于是每个标点仍然偏出去。
 *
 * ⚠️ `document.fonts.load(font)` **不带第二个参数时只探 "BESbswy" 这串拉丁字母**,
 * 探不到按 unicode-range 切出来的其它片。这里要等的是**中文标点**那一段,
 * 所以探测文本必须**显式带一个中文标点**,❌ 光给字体名不算。
 *
 * 不用 `document.fonts.ready`:那要等**页面上所有**字体(Sora / JetBrains / 图标字体)都落地,
 * 把一次本该只等终端字体的重测挂到最慢的那一个后面。只等这一支。
 *
 * 派发的是既有的 `terminal-font-changed`:它的两个订阅方(use-pty 的终端实例、
 * usePtyPaneResize 的列数控制器)本来就做「作废缓存 → 重量 → 广播新尺寸」这一串。
 * detail 不带 fontFamily/fontSize —— 字体没变,变的只是「它终于能量准了」,
 * use-pty 认这个空 detail 去扔掉 xterm 那份字宽缓存(见 flushTerminalWidthCache)。
 */
export const TERMINAL_CJK_FONT_FAMILY = 'Sarasa Mono SC';

/** 一个中文标点 + 一个拉丁字母:要用到的那几段 unicode-range 都得被点到名才会去下载。 */
const TERMINAL_FONT_PROBE_TEXT = '，W';

export function watchTerminalFontReady(): void {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  void document.fonts
    .load(`${TERMINAL_FONT_SIZE_DEFAULT}px "${TERMINAL_CJK_FONT_FAMILY}"`, TERMINAL_FONT_PROBE_TEXT)
    .then((faces) => {
      // 一个都没加载到(构建里漏了字体资产)就别广播:那只会让所有终端白重测一轮。
      if (faces.length === 0) return;
      window.dispatchEvent(new CustomEvent('terminal-font-changed', { detail: {} }));
    })
    .catch(() => {
      // 字体取不到就维持回退栈的现状,不该因此拦住会话页。
    });
}
