import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

// @@@collapse-variants (#4323) - auto 高度收放面的唯一实现。
//
// 内容高度不定时,`transition: height` 需要先量一个具体像素值,而 `max-height` 需要猜一个上界:
// 前者逐帧回流,后者猜大了收起时先"空等"、猜小了内容被裁。所以这里两个都不用 ——
// grid 容器在 `0fr`↔`1fr` 之间过渡,浏览器自己插值到内容的真实高度,不需要谁事先知道它是多少。
// 这是 design-system 里允许的那条布局动画通路(见 spec「收放只有一个机制」),
// session-ui composer 的 noticeAnimWrapper 是它在 task 侧的同源实现,不是另一套。
//
// 行为(展开态、`aria-controls`/`aria-expanded`、退场动画跑完才卸载)全部由 Base UI 出;
// 本文件只出视觉与时长曲线。reduced-motion 走 tokens.css 的全局降级,直达终态。

const collapsePanel = cn(
  // 收放本体:grid 行高从 0fr 长到 1fr。
  'grid',
  'transition-[grid-template-rows,opacity] duration-[var(--dur-med)] [transition-timing-function:var(--ease)]',
  'grid-rows-[1fr] opacity-100',
  'data-[starting-style]:grid-rows-[0fr] data-[starting-style]:opacity-0',
  'data-[ending-style]:grid-rows-[0fr] data-[ending-style]:opacity-0',
  'motion-reduce:transition-none',
)

// 子层必须能被压到 0:grid item 的默认 min-height 是 auto,不压。
const collapseInner = 'min-h-0 overflow-hidden'

export interface CollapseProps {
  /** 展开与否由调用方持有——各面的折叠状态本来就各有各的持久化。 */
  open: boolean
  children: ReactNode
  /** 加在收放面板上(内边距之类的几何),❌ 别用它另写一份时长/缓动。 */
  className?: string
  /** 面板 id,供触发按钮 `aria-controls` 指过来。 */
  id?: string
}

/**
 * auto 高度的展开/折叠。触发控件仍归调用方(各面的分组头样式不同),
 * 这里只负责"内容怎么收放"这一件事。
 */
export function Collapse({ open, children, className, id }: CollapseProps) {
  return (
    <CollapsiblePrimitive.Root open={open}>
      {/* @@@4323-hidden-until-found - Base UI 默认 `keepMounted={false}`:收起后整棵子树从 DOM 消失。
          它替换掉的 `display:none` 是留在 DOM 里的,所以直接换会**丢掉两件事** ——
          浏览器的页内查找再也搜不到折叠分组里的联系人,以及每次展开都要把整列重新挂一遍
          (头像与 effect 全部重做)。`hidden="until-found"` 两件都保住:内容仍在 DOM、
          查找命中时浏览器自己展开,视觉上仍然是收起的。 */}
      <CollapsiblePrimitive.Panel
        id={id}
        hiddenUntilFound
        data-slot="collapse-panel"
        className={cn(collapsePanel, className)}
      >
        <div className={collapseInner}>{children}</div>
      </CollapsiblePrimitive.Panel>
    </CollapsiblePrimitive.Root>
  )
}
