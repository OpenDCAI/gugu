/**
 * popupSurface — shared base style for floating popup containers.
 *
 * Encapsulates the properties that are identical across DropdownMenu, Select,
 * Combobox, and ComboboxPopup content panels: animation entry/exit keyframes
 * keyed to [data-open]/[data-closed] and [data-side], the ring shadow formula,
 * and core visual properties.
 *
 * Each primitive extends this by composing it into their own `style()`:
 *   export const menuContent = style([popupSurface, popupShadow, { overflowY: 'auto', ... }]);
 *
 * Variants in sizing (minWidth, overflowY, anchor-width usage) are applied at the
 * composing level. **Shadow depth is not a variant** — see `popupShadow` below.
 */

import { style } from '@vanilla-extract/css';
import {
  durFast,
  durMed,
  easeStandard,
  kfPopupIn,
  kfPopupOut,
  kfPopupInSlideFromTop,
  kfPopupInSlideFromBottom,
  kfPopupInSlideFromLeft,
  kfPopupInSlideFromRight,
} from '@session-ui/styles/effects/animations.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const popupSurface = style({
  position: 'relative',
  zIndex: 50,
  transformOrigin: 'var(--transform-origin)',
  // design.md shape 表:menu / popover / tooltip = --radius-surface(10px)。
  borderRadius: tokenVars.radiusSurface,
  backgroundColor: vars.surface,
  color: vars.foreground,
  outline: 'none',
  selectors: {
    '&[data-open]': { animation: `${kfPopupIn} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="bottom"]': { animation: `${kfPopupInSlideFromTop} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="top"]': { animation: `${kfPopupInSlideFromBottom} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="right"]': { animation: `${kfPopupInSlideFromLeft} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="inline-end"]': { animation: `${kfPopupInSlideFromLeft} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="left"]': { animation: `${kfPopupInSlideFromRight} ${durMed} ${easeStandard} both` },
    '&[data-open][data-side="inline-start"]': {
      animation: `${kfPopupInSlideFromRight} ${durMed} ${easeStandard} both`,
    },
    '&[data-closed]': { animation: `${kfPopupOut} ${durFast} ${easeStandard} both` },
  },
});

/**
 * 浮层的**唯一**表达(Refs #6104,assistant-ui design.md):
 * `bg + rounded-[surface|xl] + shadow-lift` —— **不再叠 ring-1**。
 *
 * design.md 的 line budget 那条:「A hairline is `border-foreground/10`.
 * **Do not stack a border, a ring, and a shadow on one edge.**」
 * 上一版(#3334 §6.1)的公式是 `shadow-sm + ring-1 ring-foreground/10`,即在同一条边上
 * 同时画环与投影 —— 那正是这条规则点名的写法。浮起来这件事由 lift 一个人说,边不再重复说一遍。
 *
 * 菜单 / 下拉 / 选择器 / combobox / 弹出层 / 对话框 / 抽屉 / toast 全部消费这一份 ——
 * 深浅不是可选项。层级由**底色**表达(`vars.surface` 比页底高一阶),不由投影深浅表达:
 * 两个都能"浮起来"的浮层若投影一深一浅,读到的是"它们不是一类东西",而它们是。
 *
 * 取值来自宿主的 `--shadow-lift`(apps/desktop/src/styles/tokens.css,随主题分明暗);
 * 括号里的兜底供脱离宿主时使用(独立 storybook / 组件测试),与本包其它 token 的写法一致。
 *
 * ⚠️ 这里从前是 `popupShadowSm` / `popupShadowMd` 两档。`Md` 的实测消费者是 **0**
 * (阳性对照:同一次普查里 `Sm` 读到 `combobox.css.ts` 的真实消费点),
 * 而三处**没有**消费它的浮层各自手抄了一遍同样的 `shadow-md` 公式 —— 一份没人用的"共享"取值,
 * 配三份复制品。所以两档合并成一档:规格说浮层只有一种表达,那它就该只有一个定义处。
 */
export const popupShadow = style({
  // fallback 只在拿不到宿主 token 时生效(storybook / 组件测试 / 外部嵌入),
  // 那些场合的默认底是**浅色** ⇒ fallback 取浅色那一档(12%)。
  // ❌ 别抄暗色值(45%):它会让这些场合的每一个浮层背四倍重的影。
  boxShadow: 'var(--shadow-lift, 0 8px 24px rgb(0 0 0 / 0.12))',
});
