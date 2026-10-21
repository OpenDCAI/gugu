import { cva } from 'class-variance-authority'
import { useCallback, useId, useRef } from 'react'
import { cn } from '@/lib/cn'
import { useTranslation } from 'react-i18next'

// @@@segtabs-variants - 分段标签样式的唯一真相。`gg-segtab-badge` 类名保留,作角标的语义锚点。
// 补了按下位移 —— 原来点下去到松手之间没有任何反馈,触屏上尤其像没点着。
const tabListVariants = cva('flex items-center', {
  variants: {
    variant: {
      pill: 'gap-1',
      underline: 'gap-[18px] border-b border-[var(--border-color)]',
    },
  },
  defaultVariants: { variant: 'pill' },
})

const tabVariants = cva(
  cn(
    'inline-flex items-center gap-1.5 cursor-pointer select-none border-none bg-transparent',
    'font-[inherit] text-[length:var(--font-body)] font-[var(--font-weight-medium)] text-[var(--muted-fg)]',
    '!transition-[background-color,color,border-color,transform] !duration-[var(--dur-med)] [transition-timing-function:var(--ease)]',
    'motion-reduce:transition-none active:scale-[0.98]',
  ),
  {
    variants: {
      variant: {
        // pill 未选中**不给底色**:一组标签里只有一个需要被指出来,给每一项都上底色等于谁都没被指出来。
        // #7333 视觉规范:分段是小控件档圆角(8)+ 中性实底色块(--muted)指出选中项,❌ 墨色反白。
        // 与列表行的选中(--selected 半透明叠色)仍是两种写法:一个是实底色块,一个是叠色。
        pill: cn(
          'rounded-[var(--radius-control)] px-3 py-[5px]',
          '[&:hover:not([data-selected])]:bg-[var(--hover)]',
          '[&:hover:not([data-selected])]:text-[var(--text-primary)]',
          'data-[selected]:bg-[var(--muted)] data-[selected]:text-[var(--text-primary)]',
        ),
        underline: cn(
          '-mb-px px-0.5 py-2 border-b-2 border-b-transparent',
          '[&:hover:not([data-selected])]:text-[var(--text-primary)]',
          'data-[selected]:border-b-[var(--primary)] data-[selected]:text-[var(--text-primary)]',
        ),
      },
    },
    defaultVariants: { variant: 'pill' },
  },
)

// 计数角标:跟着标签走,不自成一档字号。
const tabBadge = cn(
  'gg-segtab-badge inline-flex min-w-4 items-center justify-center rounded-[var(--radius-capsule)] px-1',
  'bg-[var(--accent)] text-[var(--text-on-accent)]',
  'text-[length:var(--font-caption)] font-[var(--font-weight-semibold)] leading-4',
)

/**
 * SegmentedTabs — 可访问的分段标签栏（发现页「工作台 / 广场」、广场内「好友动态 / 找群」共用）。
 *
 * 为什么要有这个组件：两处标签原本都是 `<span onClick>` —— 键盘完全够不到，读屏也读不出
 * 「这是一组标签、当前选中第几个」。macOS 上键盘可达是硬要求（HIG Full Keyboard Access），
 * 一个纯鼠标可达的主导航在 Mac 上就是坏的。
 *
 * 实现的是 WAI-ARIA tabs 模式的「手动激活」变体：
 *   - 容器 role=tablist，每项 role=tab + aria-selected + aria-controls
 *   - ←/→ 移动焦点并切换，Home/End 跳首尾（HIG Rule 5.7 箭头键导航）
 *   - roving tabindex：只有选中项进 Tab 序列，不让一组标签吃掉 N 次 Tab
 *
 * variant 只决定外观，不决定语义：
 *   - 'pill'      顶层标签（工作台 / 广场）
 *   - 'underline' 次级标签（好友动态 / 找群），比 pill 轻一档
 */

export interface SegmentedTabItem<T extends string> {
  value: T
  label: string
  /** 关联 pane 的 DOM id，供 aria-controls 指向 */
  panelId?: string
  testId?: string
  /**
   * 计数角标（>0 才渲染）。语义靠 aria-label 说出来 —— 只把数字塞进标签文本，
   * 读屏会念成「好友 3」，听不出 3 是什么。
   */
  badge?: number
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  variant = 'pill',
  ariaLabel,
}: {
  items: ReadonlyArray<SegmentedTabItem<T>>
  value: T
  onChange: (next: T) => void
  variant?: 'pill' | 'underline'
  ariaLabel: string
}) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const autoId = useId()

  // 焦点跟着选中走：切换后把焦点放到新的 tab 上，否则键盘用户按完方向键
  // 焦点还留在旧节点上，下一次方向键的起点就错了。
  const focusTab = useCallback((index: number) => {
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    nodes?.[index]?.focus()
  }, [])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.value === value)
    if (current < 0) return
    let next = current
    switch (event.key) {
      case 'ArrowRight': next = (current + 1) % items.length; break
      case 'ArrowLeft': next = (current - 1 + items.length) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    const target = items[next]
    if (!target) return
    onChange(target.value)
    focusTab(next)
  }, [items, value, onChange, focusTab])

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={cn(`gg-segtabs gg-segtabs-${variant}`, tabListVariants({ variant }))}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${autoId}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={item.panelId}
            // roving tabindex：未选中的项退出 Tab 序列，靠 ←/→ 到达。
            tabIndex={selected ? 0 : -1}
            data-selected={selected || undefined}
            data-testid={item.testId}
            className={cn('gg-segtab', tabVariants({ variant }))}
            onClick={() => { onChange(item.value) }}
            aria-label={item.badge ? t('tabs.pending', { label: item.label, count: item.badge }) : undefined}
          >
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span className={tabBadge} aria-hidden="true">{item.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
