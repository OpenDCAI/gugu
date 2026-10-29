import type { ReactNode } from 'react'
import { Button } from '../ui/Button'

/** 往群里加人 / 加 agent 的入口:一律图标加字,❌ 只剩一个认不出来的小图标或一行纯文字。 */
export function InviteButton({ icon, label, onClick, testId }: { icon: ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <Button variant="secondary" size="sm" data-testid={testId} onClick={onClick}>
      {icon}
      {label}
    </Button>
  )
}
