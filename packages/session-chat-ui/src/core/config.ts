/**
 * config — single source of truth for chat-ui typography and chip geometry.
 *
 * Exports:
 *   ChatConfig     — the one object a host provides (or omits to use defaults).
 *   DEFAULT_CONFIG — the only fallback; all values match today's hard-coded
 *                    constants so a host that omits `config` gets identical output.
 *   ResolvedTheme  — output of buildChatTheme; consumed by ThemeContext/MeasureCtx.
 *   buildChatTheme — derives ResolvedTheme from ChatConfig, call once at creation.
 *
 * Colors and radii remain CSS-themed. Font families are measurement inputs, so
 * ChatConfig drives both pretext shorthands and the runtime --chat-font-* vars.
 * A host must change them through config rather than overriding only the CSS.
 *
 * Prose geometry (list indent, blockquote indent, etc.) and row-level metrics
 * (row height, row inset) are fixed constants colocated with the code that owns
 * them — see prose/geometry.ts and engine/row-metrics.ts.
 */

import { DEFAULT_LAYOUT, type ChatLayout } from './layout/preset';

// ── VariantMetrics + FontConfig (measurement-side types) ──────────────────────
//
// Defined here (not in core/measure/fonts.ts) to avoid circular imports between
// config.ts and fonts.ts. core/measure/fonts.ts re-exports both for back-compat.

export type VariantMetrics = {
  font: string;
  lineHeight: number;
  /**
   * px font size, also carried in the `font` shorthand.
   *
   * Held separately because not every consumer of a variant shapes text with
   * pretext: KaTeX is sized by a plain CSS font-size, and parsing it back out
   * of the shorthand would be a second, drift-prone spelling of the same value.
   */
  size: number;
};

export type FontConfig = {
  body: VariantMetrics;
  bold: VariantMetrics;
  italic: VariantMetrics;
  boldItalic: VariantMetrics;
  link: VariantMetrics;
  h1: VariantMetrics;
  h2: VariantMetrics;
  h3: VariantMetrics;
  inlineCode: VariantMetrics;
  mention: VariantMetrics;
  code: VariantMetrics;
  /**
   * Total extra horizontal space for an inline-code chip (2 × inlineCodePadX).
   * Fed into pretext's `extraWidth` so shaped widths include the visual chrome.
   */
  inlineCodeExtraWidth: number;
  /**
   * Total extra horizontal space for a plain mention chip (2 × mentionPadX).
   */
  mentionExtraWidth: number;
  /**
   * Width reserved for the resolved-mention icon container (px).
   * Must equal ChipConfig.mentionIconW — read by to-rich-items and Prose.tsx.
   */
  mentionIconW: number;
  /**
   * Gap between mention icon and mention label text (px).
   * Must equal ChipConfig.mentionIconGap — read by to-rich-items and Prose.tsx.
   */
  mentionIconGap: number;
};

// ── Font families ─────────────────────────────────────────────────────────────

export type FontFamilies = {
  sans: string[];
  mono: string[];
};

// ── Type roles ────────────────────────────────────────────────────────────────

export type RoleName =
  | 'body'
  | 'body-bold'
  | 'body-italic'
  | 'body-link'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'inline-code'
  | 'mention'
  | 'code'
  | 'code-lang';

export type TypeRole = {
  family: 'sans' | 'mono';
  /** px */
  size: number;
  weight: number;
  /** px */
  lineHeight: number;
  style?: 'italic';
};

// ── Chip geometry ─────────────────────────────────────────────────────────────

export type ChipConfig = {
  /** Horizontal padding inside the inline-code chip (px). */
  inlineCodePadX: number;
  /** Vertical padding inside the inline-code chip (px). */
  inlineCodePadY: number;
  /** Horizontal padding inside the mention chip (px). */
  mentionPadX: number;
  /** Vertical padding inside the mention chip (px). */
  mentionPadY: number;
  /** Width reserved for the resolved-mention icon container (px). */
  mentionIconW: number;
  /** Gap between mention icon and mention label text (px). */
  mentionIconGap: number;
};

// ── ChatConfig ────────────────────────────────────────────────────────────────

export type ChatConfig = {
  fonts: FontFamilies;
  roles: Record<RoleName, TypeRole>;
  chips: ChipConfig;
};

// ── ResolvedTheme ─────────────────────────────────────────────────────────────

/**
 * Output of buildChatTheme — provided via ThemeContext and threaded into every
 * MeasureCtx.theme. Swapped in place by `ChatContext.setLayout` / `bumpEpoch`.
 */
export type ResolvedTheme = {
  config: ChatConfig;
  /** Transcript layout preset (#4874); see core/layout/preset.ts. */
  layout: ChatLayout;
  /** Pretext measurement side: font shorthands + derived extras. */
  fonts: FontConfig;
  chips: ChipConfig;
  /**
   * Measurement-coupled CSS variable values keyed by the TypeScript contract
   * key names (ThemeVarKey). Applied inline at the ChatRoot boundary. Colors
   * and radii stay CSS-class-themed; font families live here because glyph
   * metrics and rendered CSS must use the same value.
   */
  themeVars: Record<ThemeVarKey, string>;
};

// ── DEFAULT_CONFIG ────────────────────────────────────────────────────────────

/**
 * The only fallback for chat-ui styling. Values are byte-identical to the
 * previously hard-coded constants scattered across tokens.ts, metrics.ts, and
 * core/theme.ts. A host that does not pass a custom config gets this.
 */
export const DEFAULT_CONFIG: ChatConfig = {
  fonts: {
    // @@@font-single-source (Refs #6104) 包默认从 Inter 改成与宿主同一支栈(从前单源只在被桥接后成立)。⚠️ 字体是
    // transcript 的**测量输入**,必须字面值拿不到 CSS 变量;与 tokens.css 的 --font-family-system 逐字相同。规格 §1
    // #7333 系统字体,与宿主 tokens.css `--font-family-system` 同一条栈(必须字面值:它是测量输入)。
    sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', 'sans-serif'],
    mono: ['JetBrains Mono Variable', 'JetBrains Mono', 'Menlo', 'Monaco', 'monospace'],
  },
  roles: {
    // #7333 视觉规范:消息正文 16/24(行高 1.5);标题按字阶 24/32 · 20/28 · 16/24(半粗,同号靠字重);
    // 行内芯片(代码、提及)14,行高跟正文一行同高,不撑行盒;代码块等宽 13 是等宽那一面自己的档;代码语言标签 = 标注 12。
    body: { family: 'sans', size: 16, weight: 400, lineHeight: 24 },
    'body-bold': { family: 'sans', size: 16, weight: 600, lineHeight: 24 },
    'body-italic': { family: 'sans', size: 16, weight: 400, lineHeight: 24, style: 'italic' },
    'body-link': { family: 'sans', size: 16, weight: 400, lineHeight: 24 },
    h1: { family: 'sans', size: 24, weight: 600, lineHeight: 32 },
    h2: { family: 'sans', size: 20, weight: 600, lineHeight: 28 },
    h3: { family: 'sans', size: 16, weight: 600, lineHeight: 24 },
    'inline-code': { family: 'mono', size: 14, weight: 400, lineHeight: 24 },
    mention: { family: 'sans', size: 14, weight: 400, lineHeight: 24 },
    code: { family: 'mono', size: 13, weight: 400, lineHeight: 20 },
    'code-lang': { family: 'sans', size: 12, weight: 500, lineHeight: 16 },
  },
  chips: {
    inlineCodePadX: 6,
    inlineCodePadY: 2,
    mentionPadX: 4,
    mentionPadY: 2,
    mentionIconW: 12,
    mentionIconGap: 4,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function familyCss(config: ChatConfig, family: 'sans' | 'mono'): string {
  return (family === 'mono' ? config.fonts.mono : config.fonts.sans).join(', ');
}

/** Build a CSS font shorthand string (style? weight size family). */
export function fontShorthand(role: TypeRole, familyCssStr: string): string {
  const stylePrefix = role.style ? `${role.style} ` : '';
  return `${stylePrefix}${role.weight} ${role.size}px ${familyCssStr}`;
}

function toVariantMetrics(role: TypeRole, familyCssStr: string): VariantMetrics {
  return { font: fontShorthand(role, familyCssStr), lineHeight: role.lineHeight, size: role.size };
}

/**
 * Derive a FontConfig (pretext measurement side) from a ChatConfig.
 * Both `boldItalic` and `body-bold` read the same weight; boldItalic adds italic style.
 */
export function toFontConfig(config: ChatConfig): FontConfig {
  const sans = familyCss(config, 'sans');
  const mono = familyCss(config, 'mono');
  const r = config.roles;

  return {
    body: toVariantMetrics(r.body, sans),
    bold: toVariantMetrics(r['body-bold'], sans),
    italic: toVariantMetrics(r['body-italic'], sans),
    boldItalic: {
      font: fontShorthand({ ...r['body-bold'], style: 'italic' }, sans),
      lineHeight: r['body-bold'].lineHeight,
      size: r['body-bold'].size,
    },
    link: toVariantMetrics(r['body-link'], sans),
    h1: toVariantMetrics(r.h1, sans),
    h2: toVariantMetrics(r.h2, sans),
    h3: toVariantMetrics(r.h3, sans),
    inlineCode: toVariantMetrics(r['inline-code'], mono),
    mention: toVariantMetrics(r.mention, sans),
    code: toVariantMetrics(r.code, mono),
    inlineCodeExtraWidth: 2 * config.chips.inlineCodePadX,
    mentionExtraWidth: 2 * config.chips.mentionPadX,
    mentionIconW: config.chips.mentionIconW,
    mentionIconGap: config.chips.mentionIconGap,
  };
}

// ── ThemeVarKey ───────────────────────────────────────────────────────────────

/**
 * Keys in the global `vars` contract that are driven by runtime ChatConfig
 * (font families + typography metrics + chip padding). Must stay in sync with the `vars`
 * contract shape in styles/theme.css.ts — TypeScript enforces this in ChatRoot
 * via `vars[k as ThemeVarKey]` lookups.
 *
 * Colors and radii are excluded: they stay CSS-class-themed.
 */
export type ThemeVarKey =
  | 'fontSans'
  | 'fontMono'
  | 'typeBodyFontFamily'
  | 'typeBodyFontSize'
  | 'typeBodyFontWeight'
  | 'typeBodyLineHeight'
  | 'typeBodyBoldFontFamily'
  | 'typeBodyBoldFontSize'
  | 'typeBodyBoldFontWeight'
  | 'typeBodyBoldLineHeight'
  | 'typeBodyItalicFontFamily'
  | 'typeBodyItalicFontSize'
  | 'typeBodyItalicFontWeight'
  | 'typeBodyItalicFontStyle'
  | 'typeBodyItalicLineHeight'
  | 'typeBodyLinkFontFamily'
  | 'typeBodyLinkFontSize'
  | 'typeBodyLinkFontWeight'
  | 'typeBodyLinkLineHeight'
  | 'typeH1FontFamily'
  | 'typeH1FontSize'
  | 'typeH1FontWeight'
  | 'typeH1LineHeight'
  | 'typeH2FontFamily'
  | 'typeH2FontSize'
  | 'typeH2FontWeight'
  | 'typeH2LineHeight'
  | 'typeH3FontFamily'
  | 'typeH3FontSize'
  | 'typeH3FontWeight'
  | 'typeH3LineHeight'
  | 'typeInlineCodeFontFamily'
  | 'typeInlineCodeFontSize'
  | 'typeInlineCodeFontWeight'
  | 'typeInlineCodeLineHeight'
  | 'typeCodeFontFamily'
  | 'typeCodeFontSize'
  | 'typeCodeFontWeight'
  | 'typeCodeLineHeight'
  | 'typeCodeLangFontFamily'
  | 'typeCodeLangFontSize'
  | 'typeCodeLangFontWeight'
  | 'typeCodeLangLineHeight'
  | 'typeMentionFontFamily'
  | 'typeMentionFontSize'
  | 'typeMentionFontWeight'
  | 'icPadX'
  | 'icPadY'
  | 'mentionPadX'
  | 'mentionPadY';

/**
 * Map a ChatConfig to the measurement-coupled CSS contract values
 * (font families + typography + chip padding). Keys are the TypeScript contract key names from
 * the `vars` object in styles/theme.css.ts so ChatRoot can apply them via
 * `assignInlineVars` with a compile-time link to the contract. Colors and radii
 * remain CSS-class-themed.
 */
export function toThemeVars(config: ChatConfig): Record<ThemeVarKey, string> {
  const r = config.roles;
  const c = config.chips;

  function px(n: number): string {
    return `${n}px`;
  }

  const sans = familyCss(config, 'sans');
  const mono = familyCss(config, 'mono');

  return {
    fontSans: sans,
    fontMono: mono,
    typeBodyFontFamily: 'var(--chat-font-sans)',
    typeBodyFontSize: px(r.body.size),
    typeBodyFontWeight: String(r.body.weight),
    typeBodyLineHeight: px(r.body.lineHeight),

    typeBodyBoldFontFamily: 'var(--chat-font-sans)',
    typeBodyBoldFontSize: px(r['body-bold'].size),
    typeBodyBoldFontWeight: String(r['body-bold'].weight),
    typeBodyBoldLineHeight: px(r['body-bold'].lineHeight),

    typeBodyItalicFontFamily: 'var(--chat-font-sans)',
    typeBodyItalicFontSize: px(r['body-italic'].size),
    typeBodyItalicFontWeight: String(r['body-italic'].weight),
    typeBodyItalicFontStyle: r['body-italic'].style ?? 'normal',
    typeBodyItalicLineHeight: px(r['body-italic'].lineHeight),

    typeBodyLinkFontFamily: 'var(--chat-font-sans)',
    typeBodyLinkFontSize: px(r['body-link'].size),
    typeBodyLinkFontWeight: String(r['body-link'].weight),
    typeBodyLinkLineHeight: px(r['body-link'].lineHeight),

    typeH1FontFamily: 'var(--chat-font-sans)',
    typeH1FontSize: px(r.h1.size),
    typeH1FontWeight: String(r.h1.weight),
    typeH1LineHeight: px(r.h1.lineHeight),

    typeH2FontFamily: 'var(--chat-font-sans)',
    typeH2FontSize: px(r.h2.size),
    typeH2FontWeight: String(r.h2.weight),
    typeH2LineHeight: px(r.h2.lineHeight),

    typeH3FontFamily: 'var(--chat-font-sans)',
    typeH3FontSize: px(r.h3.size),
    typeH3FontWeight: String(r.h3.weight),
    typeH3LineHeight: px(r.h3.lineHeight),

    typeInlineCodeFontFamily: 'var(--chat-font-mono)',
    typeInlineCodeFontSize: px(r['inline-code'].size),
    typeInlineCodeFontWeight: String(r['inline-code'].weight),
    typeInlineCodeLineHeight: px(r['inline-code'].lineHeight),

    typeCodeFontFamily: 'var(--chat-font-mono)',
    typeCodeFontSize: px(r.code.size),
    typeCodeFontWeight: String(r.code.weight),
    typeCodeLineHeight: px(r.code.lineHeight),

    typeCodeLangFontFamily: 'var(--chat-font-sans)',
    typeCodeLangFontSize: px(r['code-lang'].size),
    typeCodeLangFontWeight: String(r['code-lang'].weight),
    typeCodeLangLineHeight: px(r['code-lang'].lineHeight),

    typeMentionFontFamily: 'var(--chat-font-sans)',
    typeMentionFontSize: px(r.mention.size),
    typeMentionFontWeight: String(r.mention.weight),

    icPadX: px(c.inlineCodePadX),
    icPadY: px(c.inlineCodePadY),

    mentionPadX: px(c.mentionPadX),
    mentionPadY: px(c.mentionPadY),
  };
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Derive a ResolvedTheme from a ChatConfig. Call once at app creation time;
 * later layout swaps go through `ChatContext.setLayout`.
 */
export function buildChatTheme(
  config: ChatConfig = DEFAULT_CONFIG,
  layout: ChatLayout = DEFAULT_LAYOUT
): ResolvedTheme {
  return {
    config,
    layout,
    fonts: toFontConfig(config),
    chips: config.chips,
    themeVars: toThemeVars(config),
  };
}
