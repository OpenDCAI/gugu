/**
 * copy-button.css.ts — styles for CopyButton.
 *
 * Two marker classes are exported so each reveal trigger is scoped to its own
 * context and cannot leak across nesting levels:
 *
 *   messageGroup — applied to the assistant message container; reveals the
 *                  inline footer copy button on hover.
 *   codeGroup    — applied to each code block (BlockFrame); reveals that
 *                  block's overlay copy button on hover, independently of
 *                  any sibling code blocks and of the message body hover.
 *
 * Scope guarantees:
 *   - Hovering the message body reveals only the footer inline button.
 *   - Hovering code block A reveals A's overlay only (not B's).
 *   - Hovering code block A also reveals the same message's footer button
 *     because A is a descendant of messageGroup — this is intentional.
 *   - Hover state is fully isolated between sibling messages and between
 *     sibling code blocks.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** Apply to the assistant message container to enable inline-button group-hover. */
export const messageGroup = style({});

/** Apply to each code block (BlockFrame) to enable overlay-button group-hover. */
export const codeGroup = style({});

const buttonBase = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0,
  transition: 'opacity 150ms ease',
  userSelect: 'none',
  maxWidth: '100%',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: vars.fgPassive,
  selectors: {
    '&:hover': { color: vars.fg },
    '&:focus-visible': { opacity: 1 },
    '&[data-copy-failed]': { opacity: 1 },
  },
});

export const copyButtonOverlay = style([
  buttonBase,
  {
    position: 'absolute',
    top: '6px',
    right: '6px',
    zIndex: 10,
    // 圆角走刻度:表里最小的一档是 6px,没有 4(见 tokens.css 的 8 档语义表)。
    borderRadius: vars.radiusSm,
    padding: '2px',
    selectors: {
      [`${codeGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

export const copyButtonInline = style([
  buttonBase,
  {
    gap: '4px',
    // #7333 母版字阶的标注档 12/18(消息末尾「复制 / 已复制」那行小字)。页脚行高是常量(footerH 24),
    // 按钮绝对贴在页脚里,18 的行高落在 24 里面,不会把消息末尾往下挤。
    fontSize: '12px',
    lineHeight: '18px',
    selectors: {
      [`${messageGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

export const copyFailureText = style({ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
