/**
 * preset.ts — transcript layout preset (#4874 「对话视图」).
 *
 * `single` — 单栏：每一行都占满整宽，用户消息是带边框的整宽卡片（原有观感）。
 * `double` — 双栏：用户消息收成右对齐的无边框胶囊、贴着文字宽度，左边留出一条栏，
 *            所以读起来是两栏；assistant 回复不带气泡。骨架取自 assistant-ui。
 *
 * Layout is measurement-coupled (it changes user-row geometry), so it lives on
 * the resolved theme and rides the same `measureEpoch` invalidation as typography.
 * Everything that is *only* paint (background, radius, alignment) is keyed off
 * the `data-chat-layout` attribute ChatRoot stamps on its root.
 */

import { createSignal } from 'solid-js';
import type { ResolvedTheme } from '../config';

export type ChatLayoutPreset = 'single' | 'double';

export type ChatLayout = {
  preset: ChatLayoutPreset;
  /**
   * Horizontal space (px) reserved on the user message's left in `base`, so the
   * pill reads as「mine」rather than a full-width block. The host owns the
   * viewport rule (0 below the mobile-shell breakpoint); the engine only measures
   * with whatever it is handed. Ignored in `single`.
   */
  userGutter: number;
  /** Agent-centered message bubbles, enabled by the session host. */
  agentConversation?: boolean;
};

export const DEFAULT_LAYOUT: ChatLayout = { preset: 'single', userGutter: 0 };

export function isDoubleColumnLayout(layout: ChatLayout | undefined): boolean {
  return layout?.preset === 'double';
}

export function sameLayout(a: ChatLayout, b: ChatLayout): boolean {
  return a.preset === b.preset && a.userGutter === b.userGutter && a.agentConversation === b.agentConversation;
}

/**
 * Reactive holder for a resolved theme so `ChatContext.setLayout` can swap the
 * layout in place for every view sharing the context. Create inside a Solid root.
 */
export function createThemeSignal(initial: ResolvedTheme): {
  theme: () => ResolvedTheme;
  /** Returns whether anything changed — the caller owns the measureEpoch bump. */
  setLayout: (layout: ChatLayout) => boolean;
} {
  const [theme, setTheme] = createSignal(initial);
  return {
    theme,
    setLayout(layout) {
      const current = theme();
      if (sameLayout(current.layout, layout)) return false;
      setTheme({ ...current, layout: { ...layout } });
      return true;
    },
  };
}
