import type { ReactNode, RefObject } from 'react'
import { ChevronLeft } from '@/lib/icons'

export function MobileCreatePage({
  slotRef,
  onBack,
  backLabel,
  title,
  testId,
  children,
}: {
  slotRef?: RefObject<HTMLDivElement | null>
  onBack: () => void
  backLabel: string
  title: string
  testId: string
  children?: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 8px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="gg-pressable"
          aria-label={backLabel}
          onClick={onBack}
          style={{
            width: 44,
            height: 44,
            border: 'none',
            borderRadius: 'var(--radius-xl)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <ChevronLeft size={22} />
        </button>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: 'var(--text-primary)',
            fontSize: 'var(--font-heading)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
      </div>

      <div ref={slotRef} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        {children}
      </div>
    </div>
  )
}
