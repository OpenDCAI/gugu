import { useMemo } from 'react';
import type { ChatLayout } from '@gugu/session-chat-ui';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useMediaQuery } from '@renderer/lib/hooks/use-media-query';

/**
 * Left gutter (px) reserved beside the user pill in the `base` layout, so the
 * pill reads as「mine」instead of a full-width block. assistant-ui 的双栏
 * thread uses `minmax(72px, 1fr)` for the same purpose.
 */
export const SESSION_CHAT_BASE_USER_GUTTER_PX = 72;

/**
 * Below this viewport width the gutter is dropped (owner 2026-09-03: 视口窄于
 * 720px 自动去掉用户消息的左留白，窄窗口不出现空栏). This is a plain viewport
 * rule on the session page, not a shell-mode branch; the number matches the IM
 * side's narrow-shell breakpoint so both trees agree on what「窄」means.
 */
export const SESSION_CHAT_NARROW_VIEWPORT_MAX_PX = 720;

/**
 * 偏好还没读回来时按哪一档渲染（#4981 D10）。
 *
 * ⚠️ 这不是「随便挑一个安全值」：它必须与 `settings-registry.ts` 的 `interface.chatView`
 * 出厂默认**同值**。原来这里写死 `preset !== 'double' → single`，等于把兜底钉在单栏上；
 * 而 owner 2026-09-04 已把出厂默认改成双栏（#4874/#4878）。两个数一旦分叉，症状是
 * **每次冷开会话页先渲染单栏、settings 读回来后整页跳成双栏** —— 一次可见的版式闪动，
 * 而且设置卡片在那个窗口里高亮的是「单栏」，与它马上要变成的样子相反。
 *
 * ⇒ 这个常量必须与 registry 出厂默认相等；❌ 只改 registry 那一侧。
 */
export const DEFAULT_CHAT_VIEW: ChatLayout['preset'] = 'double';

export function resolveSessionChatLayout(
  preset: ChatLayout['preset'] | undefined,
  narrowViewport: boolean
): ChatLayout {
  const resolved = preset ?? DEFAULT_CHAT_VIEW;
  if (resolved !== 'double') return { preset: 'single', userGutter: 0 };
  return { preset: 'double', userGutter: narrowViewport ? 0 : SESSION_CHAT_BASE_USER_GUTTER_PX };
}

/**
 * The transcript layout the session page should render right now: the
 * `interface.chatView` preference × the viewport rule. Memoised by value so
 * ChatTranscript's effect (and ChatContext.setLayout behind it) only fires on
 * a real change.
 */
export function useSessionChatLayout(): ChatLayout {
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const preset = interfaceSettings?.chatView;
  const narrow = useMediaQuery(`(max-width: ${SESSION_CHAT_NARROW_VIEWPORT_MAX_PX - 1}px)`);
  return useMemo(() => resolveSessionChatLayout(preset, narrow), [preset, narrow]);
}
