import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** GenericFileIcon: muted color, no flex shrink. */
export const genericFileIcon = style({
  color: vars.fgMuted,
  flexShrink: 0,
});

/**
 * 字体图标(seti 文件类型字形、mention 字形)那一枚的字号 —— **一个值,一处定义**。
 *
 * 它不是 type role:字体图标的 `font-size` 量的是字形尺寸,不是给人读的字号 ——
 * ❌ 别为了让 `check-ui-visual-spec` 的旧字阶计数归零把它改成标注档(#7333 母版补页 05:这是图标几何,
 * 要核的是字形、基线和盒子)。mention 里它装在 12×12 的槽里(session-shared markdown.css 的 .gg-md-mention-icon)。
 * 原来两个渲染点各写一遍、两个值(`Diff.tsx` 内联 12、`Prose.tsx` 内联 11),2026-09-22 统一到这枚 class 上。
 */
export const glyphIcon = style({
  fontSize: '11px',
  lineHeight: 1,
});
