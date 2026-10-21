import { style } from '@vanilla-extract/css';

/**
 * Overrides applied on top of inputVariants to turn a fixed-height input into
 * an auto-growing textarea.
 */
export const textareaOverride = style({
  height: 'auto',
  // field-sizing: content makes the textarea grow with its text content (modern browsers).
  // @@@task-fusion (#2802) — 原来这里挂了个 @ts-ignore 说 CSSType 还没有 fieldSizing;
  // 现在的类型定义里已经有了,tsgo 判定该指令多余,遂删。
  fieldSizing: 'content',
  minHeight: '4rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
});
