import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { PreviewCard } from '@base-ui/react/preview-card'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Reply, Smile } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { popupMotion } from '../ui/variants'
import { claimHoverOwner, enteredByMoving, readHoverOwner, releaseHoverOwner, setHoverOwner, subscribeHoverOwner, type HoverElements } from './hover-owner'

const HoverElementsContext = createContext<HoverElements | null>(null)

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
  // resting = the pointer is on the row but has not moved since it got there (the list scrolled under it); waiting = it moved, another row holds the bar.
  const [hovered, setHovered] = useState<'closed' | 'resting' | 'waiting' | 'open'>('closed')
  const elements = useRef<HoverElements>({ trigger: null, popup: null }).current
  const point = useRef<{ x: number; y: number } | undefined>(undefined)
  // 只订「浮窗是不是我的」:订整个 owner 时,鼠标每换一行,列表里每一行都跟着重渲(连同整只气泡)。菜单开着要接手的那一行
  // (forceOpen)和正穿过走廊的行例外,它们得看见上一位什么时候放开。
  const owner = useSyncExternalStore(subscribeHoverOwner, () => {
    const current = readHoverOwner()
    return forceOpen || hovered === 'waiting' || current?.id === id ? current : null
  })
  // 菜单 / 表情面板开着 = 锁住这一行;关上就放开(鼠标还在这一行的话照样是它的)。
  // 跟着 owner 重跑:另一行的菜单还锁着时这一行拿不到,等它放开再拿。
  useEffect(() => {
    if (enabled && forceOpen) claimHoverOwner(id, true, elements)
    else if (owner?.id === id && (owner.locked || hovered === 'closed')) setHoverOwner(hovered !== 'closed' ? { ...owner, locked: false } : null)
    else if (enabled && hovered === 'waiting' && claimHoverOwner(id, false, elements, point.current)) setHovered('open')
  }, [enabled, forceOpen, hovered, id, owner, elements])
  // Only a resting or waiting row listens to movement. Leaving the corridor takes over; leaving this row cancels its request.
  useEffect(() => {
    if (hovered !== 'waiting' && hovered !== 'resting') return
    const trigger = elements.trigger
    const document = trigger?.ownerDocument
    const leave = () => setHovered('closed')
    const move = (event: PointerEvent) => {
      if (!elements.trigger?.contains(event.target as Node)) { setHovered('closed'); return }
      point.current = { x: event.clientX, y: event.clientY }
      setHovered(claimHoverOwner(id, false, elements, point.current) ? 'open' : 'waiting')
    }
    document?.addEventListener('pointermove', move)
    trigger?.addEventListener('pointerleave', leave)
    return () => {
      document?.removeEventListener('pointermove', move)
      trigger?.removeEventListener('pointerleave', leave)
    }
  }, [hovered, id, elements])
  useEffect(() => () => releaseHoverOwner(id), [id])
  const onOpenChange: NonNullable<ComponentProps<typeof PreviewCard.Root>['onOpenChange']> = (open, details) => {
    if (!enabled) return
    const hover = details.reason === 'trigger-hover'
    point.current = hover ? { x: details.event.clientX, y: details.event.clientY } : undefined
    // A row scrolled under a still pointer is not hovered: rest until the pointer moves on it. Otherwise every row sliding by
    // mounts the bar, and each mount pays floating-ui autoUpdate's overflow-ancestor walk.
    const resting = hover && !enteredByMoving(details.event)
    setHovered(!open ? 'closed' : resting ? 'resting' : claimHoverOwner(id, false, elements, point.current) ? 'open' : 'waiting')
    if (!open && !forceOpen) releaseHoverOwner(id)
  }
  const visible = enabled && owner?.id === id && (hovered === 'open' || forceOpen)
  return (
    <HoverElementsContext.Provider value={elements}>
      <PreviewCard.Root open={visible} onOpenChange={onOpenChange}>
        <div style={style}>
          {children}
          {visible && actions}
        </div>
      </PreviewCard.Root>
    </HoverElementsContext.Provider>
  )
}

/** Travel protection belongs to the owner, so Base UI re-entry and first entry follow the same rule. */
export function MessageHoverTrigger(props: ComponentProps<typeof PreviewCard.Trigger>) {
  const elements = useContext(HoverElementsContext)
  const ref = useCallback((node: HTMLElement | null) => { if (elements) elements.trigger = node }, [elements])
  return <PreviewCard.Trigger {...props} ref={ref} onPointerMove={(event) => {
    props.onPointerMove?.(event)
    const owner = readHoverOwner()
    if (owner?.elements?.trigger === event.currentTarget) owner.point = { x: event.clientX, y: event.clientY }
  }} render={<div />} delay={0} />
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
  const elements = useContext(HoverElementsContext)
  const popupRef = useCallback((node: HTMLDivElement | null) => { if (elements) elements.popup = node }, [elements])
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
          <PreviewCard.Popup ref={popupRef} data-slot="popover-popup" className={`box-border outline-none ${popupMotion}`} style={barStyle} data-testid="message-hover-actions">
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
