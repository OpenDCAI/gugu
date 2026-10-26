import { useState, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { PreviewCard } from '@base-ui/react/preview-card'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Reply, Smile } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { popupMotion } from '../ui/variants'
import { TOOLTIP_OPEN_DELAY_MS } from '@/styles/motion'

const barStyle: CSSProperties = {
  display: 'flex', gap: 2, padding: 3,
  background: 'var(--menu-bg)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-capsule)', boxShadow: 'var(--shadow-lift)',
  pointerEvents: 'auto',
}

/** Base UI owns travel from the row into its portal (safe polygon + close delay), including button gaps. */
export function MessageHoverRegion({ enabled, forceOpen, style, children }: {
  enabled: boolean
  forceOpen: boolean
  style: CSSProperties
  children: (visible: boolean) => ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  const visible = enabled && (hovered || forceOpen)
  return (
    <PreviewCard.Root open={visible} onOpenChange={setHovered}>
      <div style={style}>
        {children(visible)}
      </div>
    </PreviewCard.Root>
  )
}

export function MessageHoverTrigger(props: ComponentProps<typeof PreviewCard.Trigger>) {
  return <PreviewCard.Trigger {...props} render={<div />} delay={TOOLTIP_OPEN_DELAY_MS} />
}

export function HoverActionBar({ isMine, isRetracted, anchorRef, reactButtonRef, moreButtonRef, onReact, onReply, onMore }: {
  isMine: boolean
  isRetracted: boolean
  anchorRef: RefObject<HTMLDivElement | null>
  reactButtonRef: RefObject<HTMLButtonElement | null>
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onReact: () => void
  onReply: () => void
  onMore: () => void
}) {
  const { t } = useTranslation('messaging')
  if (isRetracted) return null
  const actions = [
    [t('message.actions.react'), Smile, onReact, reactButtonRef],
    [t('message.actions.reply'), Reply, onReply, undefined],
    [t('message.actions.more'), Ellipsis, onMore, moreButtonRef],
  ] as const
  const boundary = anchorRef.current?.closest('[data-testid="chat-message-list"]') ?? undefined
  return (
    <PreviewCard.Portal>
        <PreviewCard.Positioner
          data-slot="popover-positioner"
          className="window-no-drag-region outline-none z-[var(--z-float)] data-[anchor-hidden]:hidden"
          anchor={() => anchorRef.current?.closest('[data-message-bubble-row]') ?? null}
          positionMethod="fixed" side="top" align={isMine ? 'start' : 'end'} sideOffset={2}
          collisionBoundary={boundary} collisionPadding={8} sticky
          collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <PreviewCard.Popup data-slot="popover-popup" className={`box-border outline-none ${popupMotion}`} style={barStyle} data-testid="message-hover-actions">
            {actions.map(([title, Icon, onClick, buttonRef]) => (
              <IconButton key={title} ref={buttonRef} size="md" shape="pill" aria-label={title} title={title}
                onClick={(event) => { event.stopPropagation(); onClick() }}>
                <span className="pointer-events-none flex size-5 items-center justify-center"><Icon size={16} /></span>
              </IconButton>
            ))}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
    </PreviewCard.Portal>
  )
}
