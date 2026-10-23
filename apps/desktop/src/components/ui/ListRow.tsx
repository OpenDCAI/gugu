import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn'

/**
 * @@@ui-ruler ListRow — 列表行的唯一几何实现(会话行 / 联系人行 / 设置导航行 / 成员行)。
 *
 * 状态(hover / press / selected / pinned)仍由 tokens.css 的 `.gg-row` 供给(data-selected / data-pinned),
 * 这里只管几何:内距、间距、头像槽、标题/副标题/时间/尾随槽的字号与截断优先级。
 * 之前三个面板的行各写一套(内距 7/8/9/13、头像 32/38/40、标题 13/15 各自决定),同一屏切 tab 时行高会跳。
 *
 * 槽位:
 *   leading   头像 / 图标(固定尺寸,调用方传 <Avatar size="sm">)
 *   title     名字(优先保宽,至少 40%)
 *   accessory 名字右边的附件(⚡bolt、设备 chip),先于名字被截断
 *   meta      右上时间(caption,tabular-nums)
 *   subtitle  第二行(预览 / 状态)
 *   trailing  第二行右侧(未读数 / 静音图标)
 *
 * 交互属性(onClick / role / aria-* / tabIndex / data-testid …)原样透传到根节点。
 * 根节点是 div:行里常嵌图标钮(删除 / 加入),按钮不能嵌按钮。
 */
export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  leading?: ReactNode
  title: ReactNode
  accessory?: ReactNode
  meta?: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  selected?: boolean
  pinned?: boolean
  /** 强调(未读):标题升 semibold。 */
  emphasis?: boolean
  /** #7333 导航行(侧栏、设置左栏):胶囊形。联系人 / 成员这类普通列表行不给,保持各自的角色。 */
  variant?: 'nav'
  mobile?: boolean
  className?: string
  /** React 19:ref 是普通 prop。键盘导航要对行 .focus() 时用它,❌ 再靠 querySelector 找回节点。 */
  ref?: Ref<HTMLDivElement>
}

export function ListRow({
  leading,
  title,
  accessory,
  meta,
  subtitle,
  trailing,
  selected,
  pinned,
  emphasis,
  variant,
  mobile,
  className,
  ref,
  ...rest
}: ListRowProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="list-row"
      data-selected={selected || undefined}
      data-pinned={pinned || undefined}
      data-emphasis={emphasis || undefined}
      data-variant={variant}
      data-mobile={mobile || undefined}
      className={cn('gg-list-row gg-row', className)}
    >
      <ListRowContent leading={leading} title={title} accessory={accessory} meta={meta} subtitle={subtitle} trailing={trailing} />
    </div>
  )
}

/** The same entity-row geometry inside a native Button, without nesting interactive roots. */
export function ListRowContent({ leading, title, accessory, meta, subtitle, trailing }: Pick<ListRowProps, 'leading' | 'title' | 'accessory' | 'meta' | 'subtitle' | 'trailing'>) {
  const secondLine = subtitle !== undefined || trailing !== undefined
  return (
    <>
      {leading ? <div className="gg-list-row-leading">{leading}</div> : null}
      <div className="gg-list-row-body">
        <div className="gg-list-row-line">
          <span className="gg-list-row-title">{title}</span>
          {accessory}
          {meta !== undefined ? <span className="gg-list-row-meta">{meta}</span> : null}
        </div>
        {secondLine ? (
          <div className="gg-list-row-line">
            {subtitle !== undefined ? <span className="gg-list-row-subtitle">{subtitle}</span> : <span className="gg-list-row-subtitle" />}
            {trailing !== undefined ? <span className="gg-list-row-trailing">{trailing}</span> : null}
          </div>
        ) : null}
      </div>
    </>
  )
}
