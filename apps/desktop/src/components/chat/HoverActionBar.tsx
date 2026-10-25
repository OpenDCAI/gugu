import type { CSSProperties, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Reply, Smile, type IconComponent } from '@/lib/icons'
import { Popover } from '../ui/Popover'
import { IconButton } from '../ui/IconButton'

const barStyle: CSSProperties = {
  display: 'flex', gap: 2, padding: 3,
  background: 'var(--menu-bg)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-capsule)', boxShadow: 'var(--shadow-lift)',
}

/* SVG override: design .ma-b svg{width:20px;height:20px} */
const MA_SVG_WRAPPER_STYLE: CSSProperties = {
  display: 'flex',
  width: '20px',
  height: '20px',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
}

function MaButton({
  title,
  icon: Icon,
  onClick,
  buttonRef,
}: {
  title: string
  icon: IconComponent
  onClick: () => void
  buttonRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <IconButton
      ref={buttonRef}
      size="md" shape="pill" aria-label={title}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      <span style={MA_SVG_WRAPPER_STYLE}>
        <Icon size={16} />
      </span>
    </IconButton>
  )
}

export function HoverActionBar({ isMine, isRetracted, isVisible, anchorRef, reactButtonRef, moreButtonRef, onReact, onReply, onMore }: {
  isMine: boolean
  isRetracted: boolean
  isVisible: boolean
  anchorRef: RefObject<HTMLDivElement | null>
  reactButtonRef: RefObject<HTMLButtonElement | null>
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onReact: () => void
  onReply: () => void
  onMore: () => void
}) {
  const { t } = useTranslation('messaging')
  if (isRetracted || !isVisible) return null
  const boundary = anchorRef.current?.closest('[data-testid="chat-message-list"]') ?? undefined
  return (
    <Popover.Root open modal={false}>
      <Popover.Portal>
        <Popover.Positioner
          className="z-[var(--z-float)] data-[anchor-hidden]:hidden"
          anchor={() => anchorRef.current?.closest('[data-message-bubble-row]') ?? null}
          positionMethod="fixed" side="top" align={isMine ? 'start' : 'end'} sideOffset={2}
          collisionBoundary={boundary} collisionPadding={8} sticky
          collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <Popover.Popup initialFocus={false} finalFocus={false} style={barStyle} data-testid="message-hover-actions">
            <MaButton title={t('message.actions.react')} icon={Smile} onClick={onReact} buttonRef={reactButtonRef} />
            <MaButton title={t('message.actions.reply')} icon={Reply} onClick={onReply} />
            <MaButton title={t('message.actions.more')} icon={Ellipsis} onClick={onMore} buttonRef={moreButtonRef} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
