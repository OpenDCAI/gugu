import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Switch } from '../ui/Switch'
import { SectionLabel } from '../ui/SectionLabel'
import './settings.css'
import './settings-content.css'

/**
 * @@@6436 设置内页的排版原语:页 → 说明 → 分组(标题 + 卡片 + 脚注)→ 行。
 * 桌面弹窗与手机「我的」用同一份标记;宽窄差别全在 settings.css,❌ 在内页里写 `mobile ?`。
 */

export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
}) {
  return (
    <Switch
      data-window-no-drag="true"
      checked={checked}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
    />
  )
}

/** 一个内页的根:各块之间一种间距。 */
export function SettingsPage({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('gg-settings-page', className)}>{children}</div>
}

/** 页首说明、分组说明、分组脚注。错误用 tone="danger"。 */
export function SettingsNote({ tone, className, children, ...rest }: HTMLAttributes<HTMLParagraphElement> & { tone?: 'danger' }) {
  return <p {...rest} data-tone={tone} className={cn('gg-settings-note', className)}>{children}</p>
}

/** 分组:标题/说明 + 按内容角色排布的行 + 原有反馈。手机沿用卡片边界。 */
export function SettingsGroup({ title, note, footer, children, className, presentation = 'form', ...rest }: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode
  note?: ReactNode
  footer?: ReactNode
  /** Content roles share controls; their composition carries the hierarchy. */
  presentation?: 'form' | 'editor' | 'navigation' | 'summary' | 'danger'
}) {
  return (
    <section {...rest} data-settings-group={presentation} className={cn('gg-settings-group', className)}>
      {title !== undefined ? <SectionLabel>{title}</SectionLabel> : null}
      {note !== undefined ? <SettingsNote>{note}</SettingsNote> : null}
      <div className="gg-settings-card window-no-drag-region">{children}</div>
      {footer}
    </section>
  )
}

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  leading?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** 行尾:开关、下拉、按钮、只读值、›。 */
  control?: ReactNode
  /** 控件比说明还宽(两个按钮、一句话的按钮):窄屏时换到说明下面,而不是把说明挤成省略号。 */
  stack?: boolean
  /** A labelled editor places its existing control below the label. */
  layout?: 'row' | 'field'
}

/**
 * 行。给了 onClick 就是整行可点的入口(role=button、Enter / 空格可按、按压反馈走 .gg-row)。
 * 根节点是 div 而不是 button:别的行尾常有自己的按钮,按钮不能嵌按钮。
 * ⚠️ 整行可点的行,行尾只放只读的值与 ›(权限、更新说明)—— 里面再放按钮,点那个按钮的同时
 * 整行的 onClick 也会跑。要按钮的行(设备的改名/删除)就不给 onClick。
 */
export function SettingsRow({ leading, title, description, control, stack, layout = 'row', onClick, onKeyDown, className, children, ...rest }: SettingsRowProps) {
  const interactive = onClick !== undefined
  const handleKeyDown = interactive
    ? (event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.currentTarget.click()
        }
      }
    : onKeyDown
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      {...rest}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      data-leading={leading !== undefined || undefined}
      data-stack={stack || undefined}
      data-settings-layout={layout}
      className={cn('gg-settings-row', interactive && 'gg-row', className)}
    >
      {leading !== undefined ? <div className="gg-settings-row-leading">{leading}</div> : null}
      <div className="gg-settings-row-body">
        {title !== undefined ? <div className="gg-settings-row-title">{title}</div> : null}
        {description !== undefined ? <div className="gg-settings-row-description">{description}</div> : null}
        {children}
      </div>
      {control !== undefined ? <div className="gg-settings-row-control">{control}</div> : null}
    </div>
  )
}
