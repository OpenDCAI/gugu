import type { ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'

/** 说明文字里的一个动作:句子里的一段强调色文字,❌ 底下另摆一颗按钮。 */
export function InlineAction({ onClick, testId, children }: { onClick: () => void; testId?: string; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'inline h-auto min-h-0 max-[719px]:min-h-0 border-0 p-0 align-baseline',
        'text-[length:inherit] leading-[inherit] font-[inherit] text-[var(--accent)]',
        'hover:underline [&:hover:not([data-disabled])]:bg-transparent',
      )}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </Button>
  )
}
