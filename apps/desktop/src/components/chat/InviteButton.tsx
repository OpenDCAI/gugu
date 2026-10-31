import type { ReactNode } from 'react'
import { Button } from '../ui/Button'

/** 带文字的邀请 / 新建 Agent 入口;成员面板的紧凑邀请动作复用 IconButton。 */
export function InviteButton({ icon, label, onClick, testId }: { icon: ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <Button variant="secondary" size="sm" data-testid={testId} onClick={onClick}>
      {icon}
      {label}
    </Button>
  )
}
