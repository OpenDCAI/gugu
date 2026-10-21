/**
 * theme.ts — public ChatTheme alias + back-compat re-exports.
 *
 * The canonical types and builder now live in core/config.ts.
 * This file re-exports everything that external consumers previously
 * imported from '@session-chat/core/theme' so the public API remains stable.
 */

export type { ChatLayout, ChatLayoutPreset } from './layout/preset';
export { DEFAULT_LAYOUT, isDoubleColumnLayout } from './layout/preset';

export type {
  ChatConfig,
  ChipConfig,
  FontConfig,
  FontFamilies,
  ResolvedTheme,
  RoleName,
  ThemeVarKey,
  TypeRole,
  VariantMetrics,
} from './config';

export {
  DEFAULT_CONFIG,
  buildChatTheme,
  fontShorthand,
  toFontConfig,
  toThemeVars,
} from './config';

/**
 * ChatTheme is an alias for ResolvedTheme (the full output of buildChatTheme).
 * Kept as a named alias so existing `theme?: ChatTheme` props compile without change.
 */
export type { ResolvedTheme as ChatTheme } from './config';

import { DEFAULT_CONFIG, buildChatTheme, type ResolvedTheme } from './config';

/** The default chat theme. Pass to ChatRoot when no custom config is needed. */
export const DEFAULT_THEME: ResolvedTheme = buildChatTheme(DEFAULT_CONFIG);
