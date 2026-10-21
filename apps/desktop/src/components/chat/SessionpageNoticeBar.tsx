// #4602 —— 会话页会话事实在当前 DM 的通知条(composer 上方的槽位):review 门(status)与会话启动失败(alert)
// 共用这一条。动作按钮走 components/ui/Button(设计系统的唯一按钮模板:sm 档在 <720px 自动 ≥44px 触控目标、
// 自带按压态,❌ 不再手搓 <button style>);正文在移动壳 ≥14px —— 规范在 CLAUDE.md「移动端」。
// 单独成文件是 react-refresh 的要求(hook 文件里不放组件),不是第二套样式:调用方只有 AgentSessionpagePresentation。
import type { ReactNode } from 'react'
import { AlertTriangle } from '@/lib/icons'
import { Button } from '../ui/Button'

export function SessionpageNoticeBar({
  testId,
  role,
  tone,
  mobile,
  title,
  body,
  action,
}: {
  testId: string
  role: 'status' | 'alert'
  tone: 'neutral' | 'danger'
  mobile: boolean
  title: string
  body: string
  action: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        padding: mobile ? '9px 10px' : '9px 22px', borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 'var(--font-body)',
      }}
    >
      <AlertTriangle size={17} style={{ color: tone === 'danger' ? 'var(--danger)' : 'var(--text-secondary)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, lineHeight: 'var(--lh-body)' }}>
        <strong style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 600 }}>{title}</strong>
        <span style={{ display: 'block', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{body}</span>
      </div>
      {action}
    </div>
  )
}

export function NoticeButton({
  testId,
  busy,
  extra,
  onClick,
  children,
}: {
  testId: string
  /** 动作在飞(打开会话页 / 重试 hydrate):禁用并给 wait 光标,❌ 不把飞行中显示成可再按。 */
  busy: boolean
  extra?: Record<`data-${string}`, string>
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      data-testid={testId}
      {...extra}
      onClick={onClick}
      disabled={busy}
      style={{ flexShrink: 0, gap: 5, cursor: busy ? 'wait' : undefined }}
    >
      {children}
    </Button>
  )
}
