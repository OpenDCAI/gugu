import { useEffect, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { PreviewCard } from '@base-ui/react/preview-card'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Reply, Smile } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { popupMotion } from '../ui/variants'
import { TOOLTIP_OPEN_DELAY_MS } from '@/styles/motion'
import { claimHoverOwner, readHoverOwner, releaseHoverOwner, setHoverOwner, subscribeHoverOwner } from './hover-owner'

const barStyle: CSSProperties = {
  display: 'flex', gap: 2, padding: 3,
  background: 'var(--menu-bg)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-capsule)', boxShadow: 'var(--shadow-lift)',
  pointerEvents: 'auto',
}

/** Base UI owns travel from the row into its portal (safe polygon + close delay), including button gaps. */
export function MessageHoverRegion({ enabled, forceOpen, style, children, actions }: {
  enabled: boolean
  forceOpen: boolean
  style: CSSProperties
  children: ReactNode
  actions: ReactNode
}) {
  const [id] = useState(() => Symbol('message-hover'))
  const [hovered, setHovered] = useState(false)
  // 只订「浮窗是不是我的」:订整个 owner 时,鼠标每换一行,列表里每一行都跟着重渲(连同整只气泡)。菜单开着要接手的那一行
  // (forceOpen)例外,它得看见上一位什么时候放开。
  const owner = useSyncExternalStore(subscribeHoverOwner, () => {
    const current = readHoverOwner()
    return forceOpen || current?.id === id ? current : null
  })
  // 菜单 / 表情面板开着 = 锁住这一行;关上就放开(鼠标还在这一行的话照样是它的)。
  // 跟着 owner 重跑:另一行的菜单还锁着时这一行拿不到,等它放开再拿。
  useEffect(() => {
    if (enabled && forceOpen) claimHoverOwner(id, true)
    else if (owner?.id === id && (owner.locked || !hovered)) setHoverOwner(hovered ? { id, locked: false } : null)
  }, [enabled, forceOpen, hovered, id, owner])
  useEffect(() => () => releaseHoverOwner(id), [id])
  const onOpenChange = (open: boolean) => {
    if (open && !claimHoverOwner(id)) return
    setHovered(open)
    if (!open && !forceOpen) releaseHoverOwner(id)
  }
  const visible = enabled && owner?.id === id && (hovered || forceOpen)
  return (
    <PreviewCard.Root open={visible} onOpenChange={onOpenChange}>
      <div style={style}>
        {children}
        {visible && actions}
      </div>
    </PreviewCard.Root>
  )
}

/**
 * 没有浮窗开着:0 延迟就开(#902)。别的行的浮窗开着:照旧等按钮提示那一拍 —— 指针正穿过这一行去够那只浮窗,❌ 一碰就把它抢走。
 * 只订「有没有浮窗开着」:换行时它不变,各行不跟着重渲。
 */
export function MessageHoverTrigger(props: ComponentProps<typeof PreviewCard.Trigger>) {
  const handover = useSyncExternalStore(subscribeHoverOwner, () => readHoverOwner() !== null)
  return <PreviewCard.Trigger {...props} render={<div />} delay={handover ? TOOLTIP_OPEN_DELAY_MS : 0} />
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
          collisionAvoidance={{ side: anchorRef.current?.querySelector('.gg-chat-reply-jump') ? 'flip' : 'shift', align: 'shift', fallbackAxisSide: 'none' }}
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
