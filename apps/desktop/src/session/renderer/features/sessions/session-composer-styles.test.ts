// #7341 项目首页贴底的输入框与会话页聊天的输入框同一个位置、同样宽:
// 这边是 Tailwind 类名,那边(packages/session-chat-ui)是几何常量 —— 任一边改了,这里红。
import { describe, expect, it } from 'vitest';
import {
  CHAT_CONTENT_GUTTER_PX,
  CHAT_CONTENT_MAX_WIDTH_REM,
  CHAT_CONTENT_MAX_WIDTH_WIDE_REM,
  CHAT_CONTENT_WIDE_BREAKPOINT_REM,
} from '@gugu/session-chat-ui/layout-geometry';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from './session-composer-styles';

/** Tailwind v4 默认刻度(这棵树的 @theme 没有覆盖 --container-* / --breakpoint-* / --spacing)。 */
const TAILWIND_CONTAINER_REM: Record<string, number> = { '2xl': 42, '3xl': 48 };
const TAILWIND_BREAKPOINT_REM: Record<string, number> = { xl: 80 };
const TAILWIND_SPACING_PX = 4;

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe('project-home docked composer geometry', () => {
  it('uses the chat column widths: 42rem, widening to 48rem at the wide breakpoint', () => {
    const width = classes(sessionComposerDockedWidthClassName);
    const base = width.find((c) => /^max-w-/.test(c));
    const wide = width.find((c) => /^[a-z0-9]+:max-w-/.test(c));
    expect(base && TAILWIND_CONTAINER_REM[base.replace('max-w-', '')]).toBe(CHAT_CONTENT_MAX_WIDTH_REM);
    const [breakpoint, wideWidth] = (wide ?? ':').split(':');
    expect(TAILWIND_BREAKPOINT_REM[breakpoint]).toBe(CHAT_CONTENT_WIDE_BREAKPOINT_REM);
    expect(TAILWIND_CONTAINER_REM[wideWidth.replace('max-w-', '')]).toBe(CHAT_CONTENT_MAX_WIDTH_WIDE_REM);
    expect(width).toContain('mx-auto');
  });

  it('keeps the chat gutter on both sides and the 8px gap above the bottom edge', () => {
    const band = classes(sessionComposerDockBandClassName);
    const px = band.find((c) => /^px-\d+$/.test(c));
    const pb = band.find((c) => /^pb-\d+$/.test(c));
    expect(Number(px?.slice(3)) * TAILWIND_SPACING_PX).toBe(CHAT_CONTENT_GUTTER_PX);
    // chat-root.css.ts 的 composerSlotInner:paddingBottom 8px。
    expect(Number(pb?.slice(3)) * TAILWIND_SPACING_PX).toBe(8);
  });
});
