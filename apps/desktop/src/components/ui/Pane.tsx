import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import './pane-header.css'

/**
 * @@@ui-ruler Pane / PaneHeader — 列与列头的唯一实现。
 *
 * 会话列表、通讯录、设置导航、发现页、会话头原来各自拍高度(47/52/56/77)、各自挑底色 token
 * (--sidebar / --bg-secondary / --bg / --nav-rail)、各自定列宽(220/272/184)。这里把「列」和「列头」
 * 做成两个只吃 tokens.css `--pane-*` / `--nav-col-w` 的壳:同一角色 = 同一几何 = 同一底色。
 * 几何全在 tokens.css 的 `.gg-pane*` 类里,这里不写任何数字。
 */
export interface PaneProps extends HTMLAttributes<HTMLDivElement> {
  role?: never
  /** nav = 左侧导航列(定宽、带右分隔线);detail = 右侧详情列(弹性)。 */
  paneRole: 'nav' | 'detail'
  mobile?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function Pane({ paneRole, mobile, className, children, ...rest }: PaneProps) {
  return (
    <div
      {...rest}
      data-slot="pane"
      data-role={paneRole}
      data-mobile={mobile || undefined}
      className={cn('gg-pane', className)}
    >
      {children}
    </div>
  )
}

export interface PaneHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** New structured headers set titleLevel; omitted slots retain the legacy title rendering. */
  title?: ReactNode
  /** Secondary context or actual state, below the title. */
  subtitle?: ReactNode
  /** Entity avatar/icon beside the title; separate from navigation leading. */
  titleLeading?: ReactNode
  /** Explicit typography: root page 24/32, detail panel 16/24. */
  titleLevel?: 'page' | 'panel'
  /** 标题左侧(移动壳返回箭头等)。 */
  leading?: ReactNode
  /** 右侧动作车道:IconButton / Button。 */
  actions?: ReactNode
  mobile?: boolean
  /** 底部分隔线(会话头需要,导航列头不需要——列头下面紧接搜索框)。 */
  divider?: boolean
  className?: string
}

export function PaneHeader({ title, subtitle, titleLeading, titleLevel, leading, actions, mobile, divider, className, children, ...rest }: PaneHeaderProps) {
  const structuredTitle = titleLevel !== undefined || subtitle !== undefined || titleLeading !== undefined
  return (
    <div
      {...rest}
      data-slot="pane-header"
      data-mobile={mobile || undefined}
      data-divider={divider || undefined}
      data-inline={mobile && Boolean(leading) || undefined}
      className={cn('gg-pane-header window-drag-region', className)}
    >
      {leading}
      {structuredTitle ? (
        <div className="gg-pane-heading">
          {titleLeading !== undefined ? <div className="gg-pane-heading-leading">{titleLeading}</div> : null}
          <div className="gg-pane-heading-copy">
            <h2 className="gg-pane-title gg-pane-heading-title" data-title-level={titleLevel ?? 'panel'}>{title}</h2>
            {subtitle !== undefined && subtitle !== null ? <div className="gg-pane-heading-subtitle">{subtitle}</div> : null}
          </div>
        </div>
      ) : typeof title === 'string' ? <h2 className="gg-pane-title">{title}</h2> : title}
      {children}
      {actions ? <div className="gg-pane-actions window-no-drag-region">{actions}</div> : null}
    </div>
  )
}
