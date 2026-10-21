/**
 * Semantic class names assigned by the TipTap mention and slash-command
 * extensions. These classes need to exist in style.css so that the serialized
 * HTML from ProseMirror (used in clipboard/copy scenarios) can be styled
 * correctly as serialized HTML from ProseMirror.
 */
import { globalStyle } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

// Applied to mention chip DOM elements in the serialized HTML representation.
globalStyle('.mention-chip', {
  display: 'inline',
  color: vars.foreground,
  verticalAlign: 'baseline',
});

// Applied to slash-command chip DOM elements in the serialized HTML representation.
// ⚠️ 字号与圆角走 token,不写字面量:这一份是**同一枚片**在剪贴板序列化 HTML 里的样子,
// 它原来写的是 0.75rem(12px,字阶上没有这一档)+ 0.375rem,而活着的那枚片是
// textSm(13px)+ radiusSm(6px) —— 同一件东西两个值,复制出去就变了样。
globalStyle('.slash-command-chip', {
  display: 'inline',
  fontSize: tokenVars.textSm,
  fontWeight: 500,
  borderRadius: tokenVars.radiusSm,
  paddingLeft: '0.25rem',
  paddingRight: '0.25rem',
  paddingTop: '0.125rem',
  paddingBottom: '0.125rem',
  color: vars.foreground,
  verticalAlign: 'baseline',
});
