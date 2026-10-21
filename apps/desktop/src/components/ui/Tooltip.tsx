/* eslint-disable react-refresh/only-export-components -- compound component namespace is intentional. */

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type { CSSProperties, ReactElement } from 'react'
import { cn } from '@/lib/cn'
import { TOOLTIP_CLOSE_DELAY_MS, TOOLTIP_OPEN_DELAY_MS } from '@/styles/motion'

type ClassNameProp = { className?: string }

// @@@tooltip-motion (#4323) - tooltip 的进出场由原语拥有,调用方只给文案和位置。
//
// 快进慢出:进场 `--dur-fast`(指针已经停在那儿等了,再慢就是迟钝),退场 `--dur-med`
// (指针扫过一排图标时,退场比进场慢一点能让它读起来是"淡出"而不是"被掐掉")。
// 位移方向跟着 `data-side` 走 —— 浮层从触发点那一侧长出来,而不是凭空在某处淡入;
// 位移只有 4px,配合缩放到 0.96,是"有节制"那一档,不是弹跳。
const tooltipPositioner = 'z-[var(--z-popover)] outline-none'
export const tooltipMotion = [
  'origin-[var(--transform-origin)]',
  // @@@tw4-transform-split - Tailwind v4 把 transform 拆成了 translate/scale/rotate 三个**独立 CSS 属性**:
  // `scale-[0.96]` 编译出的是 `scale: .96`,不是 `transform: scale(.96)`。所以只写 `transform`
  // 的过渡列表**盖不住缩放**,进出场会在两端瞬跳 —— 真编译过才看得见(见
  // tests/unit/desktop/styles/motionTransitionCoverage.test.ts,它会替我们盯着)。
  'transition-[opacity,transform,translate,scale,rotate] duration-[var(--dur-fast)] [transition-timing-function:var(--ease)]',
  'data-[ending-style]:duration-[var(--dur-med)]',
  'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.96]',
  'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.96]',
  // 朝触发点方向退回去 / 从触发点方向长出来。
  'data-[side=top]:data-[starting-style]:translate-y-1 data-[side=top]:data-[ending-style]:translate-y-1',
  'data-[side=bottom]:data-[starting-style]:-translate-y-1 data-[side=bottom]:data-[ending-style]:-translate-y-1',
  'data-[side=left]:data-[starting-style]:translate-x-1 data-[side=left]:data-[ending-style]:translate-x-1',
  'data-[side=right]:data-[starting-style]:-translate-x-1 data-[side=right]:data-[ending-style]:-translate-x-1',
  'data-[side=inline-start]:data-[starting-style]:translate-x-1 data-[side=inline-start]:data-[ending-style]:translate-x-1',
  'data-[side=inline-end]:data-[starting-style]:-translate-x-1 data-[side=inline-end]:data-[ending-style]:-translate-x-1',
  // 系统减弱动态:不淡不移,直接到终态。
  'motion-reduce:transition-none',
  'motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100',
  'motion-reduce:data-[starting-style]:translate-x-0 motion-reduce:data-[starting-style]:translate-y-0',
  'motion-reduce:data-[ending-style]:translate-x-0 motion-reduce:data-[ending-style]:translate-y-0',
].join(' ')

const tooltipPopup = cn(
  // #7333 提示条是一行字的小浮层:小控件档圆角(8)。菜单 / popover 那档(12)放在一行高的条上会接近胶囊。
  // @@@float-one-edge (Refs #6104) — 不另画描边:半像素轮廓已经在 --shadow-lift 里。
  'box-border rounded-[var(--radius-control)]',
  'bg-[var(--popover)] text-[var(--text-primary)] shadow-[var(--shadow-lift)]',
  'text-[length:var(--font-caption)] leading-[var(--lh-caption)]',
  'outline-none',
  tooltipMotion,
)

function Root(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root {...props} />
}

/**
 * 开合延迟的唯一来源。Base UI 的原始默认是 600ms 开、0ms 关 —— 600ms 慢到让人以为没有说明,
 * 0ms 关又会在指针从一个图标挪到相邻图标时闪断。
 *
 * 延迟必须挂在 **Provider** 上而不是逐个 Trigger 上:Base UI 的「一组之内已经弹过就立刻弹下一个」
 * (`useDelayGroup`)只在 Provider 存在时成立,而且 Trigger 一旦显式传了 `closeDelay`,
 * 它内部那条 `closeDelay == null && hasProvider` 的分支就永远走不到 —— 逐个传等于把分组关掉,
 * 却还留着一句"扫过一排不闪断"的注释。整个 renderer 在 App 根挂一个。
 */
function Provider({ delay = TOOLTIP_OPEN_DELAY_MS, closeDelay = TOOLTIP_CLOSE_DELAY_MS, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay} {...props} />
}

function Trigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger {...props} />
}

function Portal(props: TooltipPrimitive.Portal.Props) {
  return <TooltipPrimitive.Portal {...props} />
}

function Positioner({
  className,
  ...props
}: Omit<TooltipPrimitive.Positioner.Props, 'className'> & ClassNameProp) {
  return (
    <TooltipPrimitive.Positioner
      data-slot="tooltip-positioner"
      className={cn(tooltipPositioner, className)}
      {...props}
    />
  )
}

function Popup({
  className,
  style,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, 'className' | 'style'> &
  ClassNameProp & {
    style?: CSSProperties
  }) {
  return (
    <TooltipPrimitive.Popup
      data-slot="tooltip-popup"
      className={cn(tooltipPopup, className)}
      style={{ ...(style?.padding == null ? { padding: '6px 8px' } : {}), ...style }}
      {...props}
    />
  )
}

export interface HintProps {
  /** 说明文字。空字符串等于不要 tooltip —— 直接渲染 children,不装一个永远弹不出来的壳。 */
  label: string
  /** 被说明的控件(单个元素)。Base UI 把触发语义合并到它身上,不再多包一层盒子。 */
  children: ReactElement
  side?: TooltipPrimitive.Positioner.Props['side']
  sideOffset?: number
}

/**
 * 图标命令的说明浮层 —— 原生 `title` 的替代品。
 *
 * 原生 title 不是"省事的 tooltip",是"没有 tooltip":没有进出动效、延迟由操作系统定、
 * 触屏上根本不出现,而且长相不随主题走。这个壳把那一句话交给产品自己的浮层:
 * 键盘 focus 也会弹(Base UI 出的语义),触屏没有 hover 因而不弹 —— 这正是触屏该有的行为,
 * 触屏用户拿到的是控件自己的 `aria-label`,而不是一个跟着手指乱飘的气泡。
 *
 * 一条与原生 title 不同的边界:**`disabled` 的触发器不会弹**。浏览器不给 disabled 元素派发指针事件,
 * 而 title 是浏览器 chrome 自己画的、照弹不误。所以「按钮变灰了要解释为什么」的场合不能靠 disabled +
 * Hint,得让控件保持可聚焦(`aria-disabled` + 拦住 onClick)。
 */
export function Hint({ label, children, side = 'right', sideOffset = 8 }: HintProps) {
  if (!label) return <>{children}</>
  return (
    <Root>
      <Trigger render={children} />
      <Portal>
        <Positioner side={side} sideOffset={sideOffset} collisionPadding={8}>
          <Popup>{label}</Popup>
        </Positioner>
      </Portal>
    </Root>
  )
}

/** Base UI owns hover/focus/Escape semantics; the variant table owns the tooltip skin. */
export const Tooltip = { Provider, Root, Trigger, Portal, Positioner, Popup }
