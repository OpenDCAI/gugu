import type { CSSProperties, ReactNode } from 'react'
import { colorOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentContactTone } from './contactAgentTone'
import { Chip } from './ui/Chip'
import { Button } from './ui/Button'

// @@@add-friend-unify 从 ContactsPanel（god file，行数冻结）抽出的两个纯展示叶子控件——详情面板的
// 动作按钮与「标签：值」行。无本地组件依赖、只吃 token/inline style，抽出后 ContactsPanel 各详情面板
// （HumanDetail / AgentDetail / GroupChatDetailPane）import 复用，单向依赖不成环。

export function ActionButton({
  icon,
  label,
  primary,
  disabled,
  onClick,
  testId
}: {
  icon: ReactNode
  label: string
  primary?: boolean
  disabled?: boolean
  onClick?: () => void
  testId?: string
}) {
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="lg"
      className="leading-[var(--lh-body)]"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  )
}

/**
 * 键值表:整张表一个 grid —— 标签列按最长的那个标签取宽,值列可换行。❌ 写死标签宽度:英文标签会折行,
 * 放不下的单词(Availability)还会压进值里。不是 FieldRow 的子元素(二维码分享等)占满两列。
 */
export function FieldList({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`grid grid-cols-[max-content_minmax(0,1fr)] [&>:not([data-field-cell])]:col-span-2 ${className ?? ''}`}>{children}</div>
}

const fieldCellClass = 'flex min-h-[var(--control-h-lg)] items-center border-b border-[var(--border-color)] text-[length:var(--font-body)] leading-[var(--lh-body)]'

/** FieldList 里的一行:标签、值两格(两格各画一段底线,中间不留列间距,线是连着的)。 */
export function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <div data-field-cell className={`${fieldCellClass} whitespace-nowrap pr-2.5 text-[var(--text-tertiary)]`}>{label}</div>
      <div data-field-cell className={`${fieldCellClass} min-w-0 text-[var(--text-primary)] [overflow-wrap:anywhere]`}>{value}</div>
    </>
  )
}

/** 28×28 图标按钮（详情面板顶栏、标签编辑器返回键等）；移动端新增标签入口可显式请求 44×44 命中框。
 *  纯图标按钮必须自带无障碍名：title 在部分读屏下不作数，aria-label 才是可靠的那个（HIG 11.1）。 */
export function IconButton({
  title,
  children,
  disabled,
  onClick,
  touchTarget = false,
}: {
  title: string
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  /** Expand only the mobile hit box; the icon and its visual geometry stay unchanged. */
  touchTarget?: boolean
}) {
  return (
    <button
      className="window-no-drag-region gg-ghost"
      data-tone="strong"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={
        {
          width: touchTarget ? 44 : 28,
          height: touchTarget ? 44 : 28,
          borderRadius: 'var(--radius-control)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          WebkitAppRegion: 'no-drag'
        } as CSSProperties
      }
    >
      {children}
    </button>
  )
}

/** agent 详情头上那枚状态胶囊(点 + 那一句,从 ContactsPanel 抽出);不画状态(#7199 宿主闲时收回着)= 不出这一枚。 */
export function AgentContactStatusChip({ agentId, tone, label }: { agentId: string; tone: AgentContactTone | null; label: string }) {
  if (tone === null || !label) return null
  return (
    <Chip
      data-agent-status-surface="contact-detail"
      data-agent-id={agentId}
      style={{ color: colorOfDisplayStatus(tone) ?? undefined }}
    >
      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-current" />
      {label}
    </Chip>
  )
}
