/**
 * @@@ui-variants - 原语变体表共用的片段。
 *
 * 这里放的不是"某个组件长什么样",而是**每个可交互原语都必须给出的那几个态**:
 * hover / press / focus-visible / disabled，外加浮层的进出场。把它们写成常量而不是
 * 让每个组件各自拼一遍,是因为「四态齐全」这条约束只有集中一处才检查得动 ——
 * 散在十个文件里时,漏掉 hover 的那个组件看上去和写全了的一样正常。
 *
 * Base UI 把状态挂在 data 属性上(`data-hovered` / `data-pressed` / `data-focus-visible` /
 * `data-disabled` / `data-open` / `data-closed`),所以这些片段全部按 data 属性选择,
 * 不依赖 `:hover` —— 后者在触摸屏上会粘住,也盖不住 disabled。
 */

/**
 * @@@focus-visible-7333 (用户 2026-10-17 裁决,取代 2026-07-24 的「任何情况都无环」)
 *
 * 键盘焦点由 tokens.css 一处统一画(`@layer base` 里的 `:focus-visible` 2px live 色环,文字输入以光标为指示);
 * 鼠标点击不留环。所以这里**不导出** focusRing:原语不需要自己再画一份,画了就是第二种焦点表达。
 * ❌ 在非文字输入的可交互元素上写 `outline-none` / `focus-visible:outline-none`:那会把键盘用户的落点擦掉
 * (工具类在 @layer utilities,压得过 base 层那条全局规则)。菜单项、列表行这类自带「高亮当前项」的,
 * 高亮本身就是落点,可以保留。
 */

/**
 * Button 的 native :active：安静表面走 --press 底色，实色表面收紧亮度；两者都排除 disabled。
 * `!` 保证 press 压过同时成立的 hover；Tailwind 按 variant 排序生成 CSS，class 字符串先后不能保证层叠顺序。
 */
export const pressedSurfaceState =
  '[&:active:not([data-disabled])]:!bg-[var(--press)]'
/**
 * @@@state-ladder-mix (#2322) 实色填充钮走**透明度阶梯**(hover .88 / press .78),
 * 与 `.gg-fill`、会话页 session-ui 的 primary variant 同一配方
 * (product spec「实色填充按钮的反馈走透明度阶梯,不改底色、不缩放」)。
 * ❌ 别退回 brightness:浅色主题下 `--primary` 是纯黑,`brightness(0.9)` 乘出来还是黑 ——
 * 那等于**按下毫无反馈**,而它看起来像是写了反馈。
 */
export const pressedSolidState =
  '[&:active:not([data-disabled])]:!opacity-[0.78]'

/** 禁用态:光标 + 降透明度,并且吃掉所有 hover/press 反馈。 */
export const disabledState =
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.58] data-[disabled]:pointer-events-none'

/**
 * 控件通用转场。只动颜色/透明度/亮度,`motion-reduce` 下整体静止。
 *
 * @@@button-transition-unlayered - 这里的 `!` 不是偷懒:tokens.css 的
 * `button, [role="button"] { transition: background var(--transition-fast) }` 同样**没有 @layer**,
 * 会把任何 <button> 上的 transition 工具类整条替换成「只过渡 background、120ms」——
 * 迁移前 Button.css 因为也无 layer 且排在它之后才赢过它。真机量过:不带 `!` 时
 * primary/danger 的反馈会变成瞬时。局部逃生口,写明缘由。
 * (#2322 起实心按钮的反馈从 brightness 改成透明度阶梯,所以 filter 已从过渡表里摘掉。)
 */
export const controlTransition =
  '!transition-[background-color,background-image,border-color,color,opacity,box-shadow] !duration-[var(--dur-fast)] ease-[var(--ease)] motion-reduce:!transition-none'

/**
 * 浮层进出场。Base UI 的 `data-open` / `data-closed` 配 `data-[ending-style]` 给出真正的
 * 退场时机(元素在动画结束后才卸载),所以退场不是"直接消失"。
 * transform-origin 交给 Base UI 的 `--transform-origin`,弹层从触发点长出来而不是从中心。
 */
export const popupMotion = [
  'origin-[var(--transform-origin)]',
  // @@@tw4-transform-split - 见 Tooltip.tsx 同名注释:v4 的 scale 是独立属性,只列 transform 盖不住它。
  'transition-[opacity,transform,translate,scale,rotate] duration-[var(--dur-fast)] [transition-timing-function:var(--ease)]',
  'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.96]',
  'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.96]',
  'motion-reduce:transition-none motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100',
].join(' ')
