/**
 * theme.css.ts — VE global theme contract + chat-ui default theme.
 *
 * CONTRACT (vars)
 *   createGlobalThemeContract defines the stable public CSS variable names
 *   (--chat-fg, --chat-type-body-font-size, --chat-font-sans, ...) that every
 *   .css.ts file and host override preset depend on.
 *
 * DEFAULT THEME (createGlobalTheme × 2)
 *   The two createGlobalTheme calls are the chat-ui built-in default theme.
 *   Typography metric and chip-pad values are derived from DEFAULT_CONFIG so
 *   this file and the runtime buildChatTheme share the same single source of truth.
 *   Color/radii/family literals are kept inline here (host can override them via
 *   class-selector rules without inline-style specificity issues).
 *   Specificity is zero (:where() selectors) so any host override wins
 *   regardless of stylesheet load order.
 *
 * HOST OVERRIDE (chat-theme.css)
 *   The optional chat-theme.css preset rebinds colors and radii to the session-page
 *   design-system tokens. Font families are emitted by ChatRoot from ChatConfig
 *   because pretext must measure the same glyphs the browser renders.
 */

import { DEFAULT_CONFIG, toThemeVars } from '@session-chat/core/config';
import { createGlobalTheme, createGlobalThemeContract } from '@vanilla-extract/css';

// ── Contract (stable public names) ────────────────────────────────────────────

// The second argument to createGlobalThemeContract is a mapFn that receives
// the leaf value and returns the CSS custom property name.
// We use the value itself as the name suffix so the TS key and CSS name are
// both visible: vars.fg compiles to var(--chat-fg).

export const vars = createGlobalThemeContract(
  {
    // ── Color palette ─────────────────────────────────────────────────────────
    fg: 'chat-fg',
    fgBody: 'chat-fg-body',
    fgMuted: 'chat-fg-muted',
    fgPassive: 'chat-fg-passive',
    bg: 'chat-bg',
    bg1: 'chat-bg-1',
    bg2: 'chat-bg-2',
    bg3: 'chat-bg-3',
    // @@@state-ladder-mix 交互三态。以前没有这一格,各组件从 bg1/bg2/bg3 这条**表面**阶梯上
    // 各挑一级当 hover(diff 挑 bg3、turn-outcome 挑 bg2),于是同一种「行悬浮」在对话流里深浅不一,
    // 而且与会话页其它部分完全不同源。这三个由 chat-theme.css 桥到 --em-surface-*,
    // 最终落到咕咕那条唯一的阶梯上。
    bgHover: 'chat-bg-hover',
    bgPress: 'chat-bg-press',
    bgSelected: 'chat-bg-selected',
    border: 'chat-border',

    // User message card surface
    userCardBg: 'chat-user-card-bg',
    userCardBorder: 'chat-user-card-border',
    userCardBorderHover: 'chat-user-card-border-hover',

    // Resolved context-mention pill — per-kind bg/fg vars
    mentionChipBg: 'chat-mention-chip-bg',
    mentionChipFg: 'chat-mention-chip-fg',
    mentionFileBg: 'chat-mention-file-bg',
    mentionFileFg: 'chat-mention-file-fg',
    mentionIssueBg: 'chat-mention-issue-bg',
    mentionIssueFg: 'chat-mention-issue-fg',
    mentionSymbolBg: 'chat-mention-symbol-bg',
    mentionSymbolFg: 'chat-mention-symbol-fg',
    mentionCustomBg: 'chat-mention-custom-bg',
    mentionCustomFg: 'chat-mention-custom-fg',

    // Diff surface
    diffAdded: 'chat-diff-added',
    diffDeleted: 'chat-diff-deleted',
    diffModified: 'chat-diff-modified',

    // Misc semantic
    fgError: 'chat-fg-error',
    // @@@live-accent (Refs #6104/#6109) 转录里**唯一**表示「在动」的色。规格 §6.4;宿主桥到 --live(定义处 tokens.css)。
    live: 'chat-live',
    // 「等你批准」:不是错误(走 fgError)也不是 live(是在等人)。原来没这格,tool/diff/file-op/collapse-header 各抄一份 #eab308。
    fgPermission: 'chat-fg-permission',
    link: 'chat-link',
    bubbleUser: 'chat-bubble-user',
    bubbleUserFg: 'chat-bubble-user-fg',
    mentionBg: 'chat-mention-bg',
    mentionFg: 'chat-mention-fg',
    codeBg: 'chat-code-bg',
    codeInlineBg: 'chat-code-inline-bg',
    tableHeaderBg: 'chat-table-header-bg',
    // ❌ 原 planDone(绿)/planActive(琥珀)已删:计划行三档 = fgMuted/live/fgPassive,明度阶梯 + 唯一的蓝。规格 §6.4。

    // ── Non-color design tokens ────────────────────────────────────────────────
    fontSans: 'chat-font-sans',
    fontMono: 'chat-font-mono',
    // @@@shape-table (Refs #6104) 8 档语义表的逐字等值副本,定义处 tokens.css。规格 §5。
    // @@@type-chrome (Refs #6104) chrome 字号闭集三档 13/11/10(静态,不进 ThemeVarKey)。与 typeBody* 的分界:
    // typeBody 是**内容**字号、宿主注入、跟着移动壳变;chrome 是**界面自己**的、不跟着变。规格 §2.2。
    typeChromeFontSize: 'chat-type-chrome-font-size',
    typeChromeTinyFontSize: 'chat-type-chrome-tiny-font-size',
    typeChromeMicroFontSize: 'chat-type-chrome-micro-font-size',

    radiusSm: 'chat-radius-sm',
    radiusMd: 'chat-radius-md',
    radiusXl: 'chat-radius-xl',
    radiusThread: 'chat-radius-thread',
    radiusFull: 'chat-radius-full',

    // ── Private typography (--chat-type-*) ────────────────────────────────────
    // These names must NOT change — prose.css.ts / diff.css.ts reference them
    // and any rename breaks the measure === offsetHeight invariant.
    typeBodyFontFamily: 'chat-type-body-font-family',
    typeBodyFontSize: 'chat-type-body-font-size',
    typeBodyFontWeight: 'chat-type-body-font-weight',
    typeBodyLineHeight: 'chat-type-body-line-height',

    typeBodyBoldFontFamily: 'chat-type-body-bold-font-family',
    typeBodyBoldFontSize: 'chat-type-body-bold-font-size',
    typeBodyBoldFontWeight: 'chat-type-body-bold-font-weight',
    typeBodyBoldLineHeight: 'chat-type-body-bold-line-height',

    typeBodyItalicFontFamily: 'chat-type-body-italic-font-family',
    typeBodyItalicFontSize: 'chat-type-body-italic-font-size',
    typeBodyItalicFontWeight: 'chat-type-body-italic-font-weight',
    typeBodyItalicFontStyle: 'chat-type-body-italic-font-style',
    typeBodyItalicLineHeight: 'chat-type-body-italic-line-height',

    typeBodyLinkFontFamily: 'chat-type-body-link-font-family',
    typeBodyLinkFontSize: 'chat-type-body-link-font-size',
    typeBodyLinkFontWeight: 'chat-type-body-link-font-weight',
    typeBodyLinkLineHeight: 'chat-type-body-link-line-height',

    typeH1FontFamily: 'chat-type-h1-font-family',
    typeH1FontSize: 'chat-type-h1-font-size',
    typeH1FontWeight: 'chat-type-h1-font-weight',
    typeH1LineHeight: 'chat-type-h1-line-height',

    typeH2FontFamily: 'chat-type-h2-font-family',
    typeH2FontSize: 'chat-type-h2-font-size',
    typeH2FontWeight: 'chat-type-h2-font-weight',
    typeH2LineHeight: 'chat-type-h2-line-height',

    typeH3FontFamily: 'chat-type-h3-font-family',
    typeH3FontSize: 'chat-type-h3-font-size',
    typeH3FontWeight: 'chat-type-h3-font-weight',
    typeH3LineHeight: 'chat-type-h3-line-height',

    typeInlineCodeFontFamily: 'chat-type-inline-code-font-family',
    typeInlineCodeFontSize: 'chat-type-inline-code-font-size',
    typeInlineCodeFontWeight: 'chat-type-inline-code-font-weight',
    typeInlineCodeLineHeight: 'chat-type-inline-code-line-height',

    typeCodeFontFamily: 'chat-type-code-font-family',
    typeCodeFontSize: 'chat-type-code-font-size',
    typeCodeFontWeight: 'chat-type-code-font-weight',
    typeCodeLineHeight: 'chat-type-code-line-height',

    typeCodeLangFontFamily: 'chat-type-code-lang-font-family',
    typeCodeLangFontSize: 'chat-type-code-lang-font-size',
    typeCodeLangFontWeight: 'chat-type-code-lang-font-weight',
    typeCodeLangLineHeight: 'chat-type-code-lang-line-height',

    // Mention chip typography (size/weight emitted at runtime like all other roles).
    typeMentionFontFamily: 'chat-type-mention-font-family',
    typeMentionFontSize: 'chat-type-mention-font-size',
    typeMentionFontWeight: 'chat-type-mention-font-weight',

    // ── Chip padding (runtime-settable by ChatRoot) ────────────────────────────
    icPadX: 'chat-ic-pad-x',
    icPadY: 'chat-ic-pad-y',
    mentionPadX: 'chat-mention-pad-x',
    mentionPadY: 'chat-mention-pad-y',
  },
  (value) => `--${value}`
);

// ── Shared non-color tokens ────────────────────────────────────────────────────
//
// Typography metrics and chip padding derive from DEFAULT_CONFIG via toThemeVars
// (same source of truth as buildChatTheme) so build-time defaults and runtime
// inline-var emission can never drift from each other. Both createGlobalTheme
// blocks spread these; each block then only lists its own color palette.
//
// Radius tokens are static across themes, so they live here too.
// The vars contract keys match the ThemeVarKey union in config.ts exactly —
// TypeScript enforces this in ChatRoot via vars[k as ThemeVarKey] lookups.

const NON_COLOR_VARS = {
  // @@@type-chrome (Refs #6104) chrome 三档(#7333 母版):正文 14(逐字等值于宿主 --text-chrome-body,紧凑界面 14/20)、
  // 标记 12(标注档 12/18)、micro 10 —— micro 只量折叠箭头的字形大小,是图标几何,不是文字档。行高由各消费方写。
  typeChromeFontSize: '14px',
  typeChromeTinyFontSize: '12px',
  typeChromeMicroFontSize: '10px',
  radiusSm: '6px',
  radiusMd: '8px',
  radiusXl: '12px',
  radiusThread: '16px',
  radiusFull: '9999px',
  // Typography + chip padding — all derived from DEFAULT_CONFIG.
  ...toThemeVars(DEFAULT_CONFIG),
};

// ── Light theme ────────────────────────────────────────────────────────────────

createGlobalTheme(':where(:root), :where(.emlight)', vars, {
  fg: '#21201f',
  fgBody: 'color-mix(in srgb, #616060 40%, #21201f)',
  fgMuted: '#616060',
  fgPassive: '#8e8d8d',
  bg: '#fcfcfc',
  bg1: '#f1f0f0',
  bg2: '#e5e4e4',
  bg3: '#dadada',
  // 脱离咕咕皮肤(独立 storybook)时的兜底,值 = 咕咕浅色阶梯叠在 bg 上的等效实色。
  bgHover: '#f6f6f6',
  bgPress: '#efefef',
  bgSelected: '#eef3fd',
  border: '#c5c4c4',
  userCardBg: '#f1f0f0',
  userCardBorder: '#c5c4c4',
  userCardBorderHover: '#b3b2b2',
  mentionChipBg: '#e7e6e6',
  mentionChipFg: '#21201f',
  mentionFileBg: '#e7e6e6',
  mentionFileFg: '#21201f',
  // @@@chrome-is-ink (Refs #6104) mention chip 原按种类分色(issue 蓝/symbol 紫)= Reject 的「colored category chips」;区分靠图标与文字。
  mentionIssueBg: '#e7e6e6',
  mentionIssueFg: '#21201f',
  mentionSymbolBg: '#e7e6e6',
  mentionSymbolFg: '#21201f',
  mentionCustomBg: '#e7e6e6',
  mentionCustomFg: '#21201f',
  diffAdded: '#4f9f4f',
  diffDeleted: '#d56761',
  diffModified: '#c28c00',
  fgError: '#d56761',
  // @@@live-accent 浅底上用满饱和那一档(= tokens.css 的 --live 浅色值,blue-500)。
  live: 'oklch(0.623 0.188 260)',
  fgPermission: '#a16207',
  link: '#2263a4',
  bubbleUser: '#dadada',
  bubbleUserFg: '#21201f',
  mentionBg: '#e7e6e6',
  mentionFg: '#21201f',
  codeBg: '#fcfcfc',
  codeInlineBg: 'rgba(0, 0, 0, 0.06)',
  tableHeaderBg: '#f1f0f0',
  ...NON_COLOR_VARS,
});

// ── Dark theme ─────────────────────────────────────────────────────────────────
// Only colors differ from light — typography and geometry are theme-independent.

createGlobalTheme(':where(.emdark)', vars, {
  fg: '#e9e8e9',
  fgBody: 'color-mix(in srgb, #b8b7b8 40%, #e9e8e9)',
  fgMuted: '#b8b7b8',
  fgPassive: '#929091',
  bg: '#111111',
  bg1: '#181818',
  bg2: '#202020',
  bg3: '#282727',
  // 兜底同上,暗色侧。
  bgHover: '#171717',
  bgPress: '#1e1e1e',
  bgSelected: '#212121',
  border: '#373636',
  userCardBg: '#181818',
  userCardBorder: '#373636',
  userCardBorderHover: '#525050',
  mentionChipBg: '#2a2929',
  mentionChipFg: '#e6e6e6',
  mentionFileBg: '#2a2929',
  mentionFileFg: '#e6e6e6',
  // @@@chrome-is-ink — 见 light 那段。
  mentionIssueBg: '#2a2929',
  mentionIssueFg: '#e6e6e6',
  mentionSymbolBg: '#2a2929',
  mentionSymbolFg: '#e6e6e6',
  mentionCustomBg: '#2a2929',
  mentionCustomFg: '#e6e6e6',
  diffAdded: '#54a55a',
  diffDeleted: '#dc6b67',
  diffModified: '#ce981d',
  fgError: '#dc6b67',
  // @@@live-accent 暗底上退一档饱和(= tokens.css 的 --live 暗色值)。
  live: 'oklch(0.714 0.143 255)',
  fgPermission: '#dead52',
  link: '#7cbcff',
  bubbleUser: '#282727',
  bubbleUserFg: '#e9e8e9',
  mentionBg: '#2a2929',
  mentionFg: '#e6e6e6',
  codeBg: '#111111',
  codeInlineBg: 'rgba(255, 255, 255, 0.08)',
  tableHeaderBg: '#181818',
  ...NON_COLOR_VARS,
});
