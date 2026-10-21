/**
 * tokens.css.ts — Non-color design tokens in Vanilla Extract.
 *
 * Replaces the :root { --font-*, --text-*, --radius-*, --font-weight-*, --animate-* }
 * blocks that were hand-maintained in theme.base.css. Values are emitted into
 * the host app's bundled CSS via the VE build pipeline.
 *
 * Exports a typed `tokenVars` contract so consumers can reference these tokens
 * with full TypeScript safety rather than raw `'var(--text-sm)'` strings.
 * The sprinkles fontSize / fontWeight / fontFamily / borderRadius properties
 * use these refs.
 *
 * Also emits composite typography role vars (--type-*) which are derived from
 * the primitive tokens; these remain as plain strings since they chain one var
 * into another and cannot be represented in the VE typed-vars map.
 */

import { nsName } from '@session-ui/theme/core/contract/namespace';
import { createGlobalThemeContract, globalStyle } from '@vanilla-extract/css';

// ── Primitive non-color token contract ────────────────────────────────────────

export const tokenVars = createGlobalThemeContract(
  {
    // Font families
    fontSans: 'font-sans',
    fontMono: 'font-mono',

    // Font weight scale
    fontWeightNormal: 'font-weight-normal',
    fontWeightMedium: 'font-weight-medium',
    fontWeightSemibold: 'font-weight-semibold',
    fontWeightBold: 'font-weight-bold',

    // Primitive type size scale —— 咕咕字阶 11/13/15/17/20,与主 app 的
    // --font-caption/body/title/heading/size-xl 一一对应。
    // @@@task-ui-type-ladder 删掉过的四档,别再加回来:
    //   10px(micro) 零消费者,且低于移动端 14px 正文下限;
    //   12px(xs)    与 13px 只差 1px —— 那不是层级信号,是噪声。原来的 28 处按角色
    //               拆进了 11(附属信息)与 13(要读的内容/可交互控件);
    //   14px(base)  主 app 已在 #4931 消灭;这里的 6 个 role var 本就被 app 层
    //               .gugu-skin 盖成 13/15,包默认值只是和产品不一致的第二套字阶;
    //   24px(2xl)   零引用的死档。
    // 跨字体的视觉补偿不靠新开一档,用相对值(见下面 inline-code 的 0.92em)。
    textTiny: 'text-tiny',
    textTinyLineHeight: 'text-tiny--line-height',
    textSm: 'text-sm',
    textSmLineHeight: 'text-sm--line-height',
    textTitle: 'text-title',
    textTitleLineHeight: 'text-title--line-height',
    textLg: 'text-lg',
    textLgLineHeight: 'text-lg--line-height',
    textXl: 'text-xl',
    textXlLineHeight: 'text-xl--line-height',

    // Radius scale —— 圆角语义表(Refs #6104;#7333 起按视觉规范:xs 4 / surface 12 / thread 24)。
    // 定义处是 apps/desktop/src/styles/tokens.css;这里是 vanilla-extract 那半边的逐字等值副本
    // (VE 的 vars map 只吃静态字符串,拿不到宿主的 var())。
    // @@@task-ui-shape-table 改过名的两档,❌ 别把旧名加回来:
    //   radiusXl   0.875rem(14px) → 12px    —— 14 在任何一张刻度上都没有对应值
    //   radius2xl  1.25rem(20px)  → radiusThread —— composer 卡片那一档(--radius-thread)
    radius: 'radius',
    radiusXs: 'radius-xs',
    radiusSm: 'radius-sm',
    radiusMd: 'radius-md',
    radiusSurface: 'radius-surface',
    radiusXl: 'radius-xl',
    radiusThread: 'radius-thread',
    radiusFull: 'radius-full',

    // Named animation shorthands
    animateAccordionDown: 'animate-accordion-down',
    animateAccordionUp: 'animate-accordion-up',
    animatePanelBlurIn: 'animate-panel-blur-in',
    animatePanelBlurOut: 'animate-panel-blur-out',
  },
  (name) => nsName(name ?? '')
);

export type TokenVars = typeof tokenVars;

// ── Assign static values at :root ─────────────────────────────────────────────

globalStyle(':root', {
  vars: {
    // Font families
    // @@@font-single-source (Refs #6104) — 包默认值从 'Inter Variable' 改成与宿主同一支栈。
    // 从前宿主在 EmdashSessionFrame 的皮肤桥里把它盖成 Sora,包自己默认仍是 Inter ——
    // 「单源只在被桥接后才成立」,storybook / 组件测试 / 任何直接用本包的场合看到的是另一张脸。
    // ❌ 不写 var(--font-family-system):VE 的 vars map 只吃静态字符串,且这里就是**兜底**那一层。
    // #7333 起宿主正文是系统字体,包默认跟着同一条栈。
    [tokenVars.fontSans]:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif",
    [tokenVars.fontMono]: "'JetBrains Mono Variable', 'JetBrains Mono', Menlo, Monaco, monospace",

    // Font weight scale
    [tokenVars.fontWeightNormal]: '400',
    [tokenVars.fontWeightMedium]: '500',
    [tokenVars.fontWeightSemibold]: '600',
    [tokenVars.fontWeightBold]: '700',

    // Primitive type size scale —— 咕咕字阶(#7333:12/18 · 14/20 · 16/24 · 20/28 · 24/32),与 tokens.css 逐档等值。
    [tokenVars.textTiny]: '12px',
    [tokenVars.textTinyLineHeight]: '18px',
    [tokenVars.textSm]: '14px',
    [tokenVars.textSmLineHeight]: '20px',
    [tokenVars.textTitle]: '16px',
    [tokenVars.textTitleLineHeight]: '24px',
    [tokenVars.textLg]: '20px',
    [tokenVars.textLgLineHeight]: '28px',
    [tokenVars.textXl]: '24px',
    [tokenVars.textXlLineHeight]: '32px',

    // Radius scale — 与 tokens.css 的圆角表逐字相同(px 而不是 rem:表用 px,两边写法一致才好对拍)
    [tokenVars.radius]: '8px',        // = --radius-control
    [tokenVars.radiusXs]: '4px',      // = --radius-xs
    [tokenVars.radiusSm]: '6px',      // = --radius-sm
    [tokenVars.radiusMd]: '8px',      // = --radius-control
    [tokenVars.radiusSurface]: '12px',// = --radius-surface(menu / popover / 分组卡)
    [tokenVars.radiusXl]: '12px',     // = --radius-xl(toast / floating card)
    [tokenVars.radiusThread]: '24px', // = --radius-thread(composer)
    [tokenVars.radiusFull]: '9999px', // = --radius-capsule

    // Named animation shorthands
    [tokenVars.animateAccordionDown]: 'accordion-down 0.2s ease-out',
    [tokenVars.animateAccordionUp]: 'accordion-up 0.2s ease-out',
    [tokenVars.animatePanelBlurIn]: 'panel-blur-in 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    [tokenVars.animatePanelBlurOut]: 'panel-blur-out 140ms ease-in',
  },
});

// ── Composite typography role vars ────────────────────────────────────────────
//
// These chain var→var so they can't go in the typed contract (VE only accepts
// static strings in the `vars` map). They keep the same --type-* names for
// backward compatibility with typography.css.

globalStyle(':root', {
  [nsName('type-body-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-body-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-body-font-weight')]: `var(${tokenVars.fontWeightNormal})`,
  [nsName('type-body-line-height')]: '18px',

  [nsName('type-body-bold-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-body-bold-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-body-bold-font-weight')]: `var(${tokenVars.fontWeightSemibold})`,
  [nsName('type-body-bold-line-height')]: '18px',

  [nsName('type-body-italic-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-body-italic-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-body-italic-font-weight')]: `var(${tokenVars.fontWeightNormal})`,
  [nsName('type-body-italic-font-style')]: 'italic',
  [nsName('type-body-italic-line-height')]: '18px',

  [nsName('type-body-link-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-body-link-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-body-link-font-weight')]: `var(${tokenVars.fontWeightNormal})`,
  [nsName('type-body-link-line-height')]: '18px',

  [nsName('type-h1-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-h1-font-size')]: `var(${tokenVars.textXl})`,
  [nsName('type-h1-font-weight')]: `var(${tokenVars.fontWeightSemibold})`,
  [nsName('type-h1-line-height')]: '28px',

  [nsName('type-h2-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-h2-font-size')]: `var(${tokenVars.textLg})`,
  [nsName('type-h2-font-weight')]: `var(${tokenVars.fontWeightSemibold})`,
  [nsName('type-h2-line-height')]: '25px',

  [nsName('type-h3-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-h3-font-size')]: `var(${tokenVars.textTitle})`,
  [nsName('type-h3-font-weight')]: `var(${tokenVars.fontWeightSemibold})`,
  [nsName('type-h3-line-height')]: '21px',

  [nsName('type-inline-code-font-family')]: `var(${tokenVars.fontMono})`,
  // ❌ 不给它开一档 px:mono 比 sans 视觉偏大,这里要的是跨字体光学补偿而不是层级。
  // 0.92em 跟着周围正文走(13 → 11.96,与原来写死的 12px 差 0.04px),
  // 标题里的行内代码也就自动跟着标题放大 —— 写死 px 做不到这件事。
  // 与 markdown.css(`.gg-md` 行内 code 0.92em)同一条约定。
  [nsName('type-inline-code-font-size')]: '0.92em',
  [nsName('type-inline-code-font-weight')]: `var(${tokenVars.fontWeightNormal})`,
  [nsName('type-inline-code-line-height')]: '20px',

  [nsName('type-code-font-family')]: `var(${tokenVars.fontMono})`,
  [nsName('type-code-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-code-font-weight')]: `var(${tokenVars.fontWeightNormal})`,
  [nsName('type-code-line-height')]: '20px',

  [nsName('type-code-lang-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-code-lang-font-size')]: `var(${tokenVars.textTiny})`,
  [nsName('type-code-lang-font-weight')]: `var(${tokenVars.fontWeightMedium})`,
  [nsName('type-code-lang-line-height')]: '16px',

  [nsName('type-mention-font-family')]: `var(${tokenVars.fontSans})`,
  [nsName('type-mention-font-size')]: `var(${tokenVars.textSm})`,
  [nsName('type-mention-font-weight')]: `var(${tokenVars.fontWeightSemibold})`,
  [nsName('type-mention-line-height')]: '18px',
});
