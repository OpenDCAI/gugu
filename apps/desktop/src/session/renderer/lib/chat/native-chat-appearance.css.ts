import { globalStyle, style } from '@vanilla-extract/css';
import { CHAT_COMPOSER_EDGE_FADE_PX } from '@gugu/session-chat-ui/layout-geometry';

/**
 * 会话页通用对话的外观(用户 2026-10-17 的原生聊天参考,Refs #7324;#7333 起消费全局 token)。
 * 字体(系统栈)与圆角(composer / 用户气泡 24,会话页 index.css 的 --chat-radius-thread)已经是全局取值,这里不再就地覆盖;
 * 主输入框只留轻边框(--border / --border-strong),不加外投影(用户 2026-10-19,Refs #7528)。
 * 对话专属绘制还包括用户气泡/停止钮反色、过程分隔线、日期居中和上下渐隐;几何与动作沿用宿主契约。
 */

/** Creation and in-session composers share the same appearance contract. */
export const nativeComposerAppearance = style({
  vars: {
    '--composer-border': 'var(--border)',
    '--composer-border-strong': 'var(--border-strong)',
  },
});

/** Native conversation appearance; see product spec (Refs #7324). */
export const nativeChatAppearance = style([nativeComposerAppearance, {
  vars: {
    '--chat-fg-body': 'var(--foreground)',
    '--chat-user-card-bg': 'var(--foreground)',
    '--chat-bubble-user': 'var(--foreground)',
    '--chat-bubble-user-fg': 'var(--background)',
  },
}]);

globalStyle(`${nativeChatAppearance} [data-slot="turn-process"]`, {
  position: 'relative',
});

// Paint the divider inside the measured row without shrinking its button.
globalStyle(`${nativeChatAppearance} [data-slot="turn-process"]::after`, {
  content: '""', position: 'absolute', left: 0, right: 0, bottom: 0,
  borderBottom: '1px solid var(--chat-border)', pointerEvents: 'none',
});

// Agent-centered sessions use a quiet footer disclosure instead of a process divider.
globalStyle(`${nativeChatAppearance} [data-chat-root][data-agent-conversation="true"] [data-slot="turn-process"]::after`, { display: 'none' });

globalStyle(`${nativeChatAppearance} [data-composer-action="stop"]`, {
  backgroundColor: 'var(--foreground)', color: 'var(--background)', borderColor: 'transparent',
});

// The native reference uses one quiet, centered date/time above the messages.
globalStyle(`${nativeChatAppearance} [data-slot="day-separator"]`, { justifyContent: 'center' });
globalStyle(`${nativeChatAppearance} [data-slot="day-separator-rule"]`, { display: 'none' });

// Viewport-bound fades soften both scrolling messages and the pinned user card.
// They do not intercept input or change measured row heights. The lower fade
// follows the actual composer layer as drafts and attachments change its height.
globalStyle(`${nativeChatAppearance} [data-chat-root]::before`, {
  content: '""',
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 16,
  zIndex: 11,
  pointerEvents: 'none',
  background: 'linear-gradient(to bottom, var(--chat-bg), transparent)',
});

globalStyle(`${nativeChatAppearance} [data-chat-composer-placement="bottom"]::before`, {
  content: '""',
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  height: CHAT_COMPOSER_EDGE_FADE_PX,
  // Stay above the transcript within the composer's stacking context, but below the card.
  zIndex: -1,
  pointerEvents: 'none',
  background: 'linear-gradient(to top, var(--chat-bg), transparent)',
});
