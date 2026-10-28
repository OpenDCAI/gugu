import { useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useTranslation } from 'react-i18next'
import { QUICK_REACTIONS, REACTIONS, reactionLabel } from '@gugu/core/shared/ui/reactionCatalog'
import { Plus } from '@/lib/icons'
import { Popover } from '../ui/Popover'
import { Button } from '../ui/Button'

const FREQUENCY_KEY = 'gugu.reaction-frequency'

/** 桌面回应浮层与手机长按面板共用:一行常用 + 目录里的精选回应,在原面板内切换。 */
export function EmojiQuickPicker({ anchor, onPick, onClose, onExpand, children, disabled = false, menu = false }: {
  anchor?: Element | RefObject<Element | null>
  onPick: (emoji: string) => void
  onClose: () => void
  onExpand?: () => void
  children?: ReactNode
  disabled?: boolean
  menu?: boolean
}) {
  const { t, i18n } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const frequency: Record<string, number> = JSON.parse(localStorage.getItem(FREQUENCY_KEY) ?? '{}')
  const emojis = [...new Set([...REACTIONS.filter(({ emoji }) => frequency[emoji] > 0).sort((a, b) => frequency[b.emoji] - frequency[a.emoji]).map(({ emoji }) => emoji), ...QUICK_REACTIONS.map(({ emoji }) => emoji)])].slice(0, 6)
  const pick = (emoji: string) => {
    localStorage.setItem(FREQUENCY_KEY, JSON.stringify({ ...frequency, [emoji]: (frequency[emoji] ?? 0) + 1 }))
    localStorage.removeItem('emoji-mart.frequently')
    localStorage.removeItem('emoji-mart.last')
    onPick(emoji); onClose()
  }
  const handleToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    event.stopPropagation()
    buttons[next]?.focus()
  }
  const body = disabled ? children : expanded ? (
    <>
      <section aria-label={t('emoji.workStatus')} className="pb-2">
        <div className="pb-1 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{t('emoji.workStatus')}</div>
        <div className="grid grid-cols-3">
          {REACTIONS.filter(({ kind }) => kind === 'status').map(({ emoji }) => <Button key={emoji} variant="ghost" className="px-1" onClick={() => pick(emoji)}><span className="text-[length:var(--font-size-xl)]">{emoji}</span>{reactionLabel(emoji, i18n.language)}</Button>)}
        </div>
      </section>
      <section aria-label={t('emoji.reactions')}>
        <div className="pb-1 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{t('emoji.reactions')}</div>
        <div className="grid grid-cols-6 justify-items-center">
          {REACTIONS.filter(({ kind }) => kind === 'mood').map(({ emoji }) => <QuickReactionButton key={emoji} menu={menu} title={reactionLabel(emoji, i18n.language) ?? emoji} label={t('emoji.reactWith', { emoji: `${emoji} ${reactionLabel(emoji, i18n.language) ?? ''}`.trim() })} onClick={() => pick(emoji)}>{emoji}</QuickReactionButton>)}
        </div>
      </section>
    </>
  ) : (
    <>
      <div role={menu ? 'group' : 'toolbar'} aria-label={t('emoji.quickReactions')} onKeyDown={handleToolbarKeyDown} className="grid grid-cols-7 justify-items-center pb-2">
        {emojis.map((emoji) => <QuickReactionButton key={emoji} menu={menu} title={reactionLabel(emoji, i18n.language) ?? emoji} label={t('emoji.reactWith', { emoji: `${emoji} ${reactionLabel(emoji, i18n.language) ?? ''}`.trim() })} onClick={() => pick(emoji)}>{emoji}</QuickReactionButton>)}
        <QuickReactionButton menu={menu} label={t('emoji.moreReactions')} onClick={() => { setExpanded(true); onExpand?.() }}><Plus size={20} /></QuickReactionButton>
      </div>
      {children}
    </>
  )
  return anchor ? (
    <Popover.Root open modal={false} onOpenChange={(open) => { if (!open) onClose() }}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} positionMethod="fixed" side="bottom" align="start" sideOffset={6} collisionPadding={8} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}>
          <Popover.Popup className="box-border w-[min(366px,calc(100vw-16px))] overflow-hidden rounded-[var(--radius-surface)] bg-[var(--menu-bg)] p-2 text-[var(--menu-fg)] shadow-[var(--shadow-menu)]">{body}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  ) : body
}

function QuickReactionButton({ menu, label, title, onClick, children }: {
  menu: boolean; label: string; title?: string; onClick: () => void; children: ReactNode
}) {
  const props = { 'aria-label': label, title, onClick, className: 'text-[length:var(--font-size-xl)] data-[highlighted]:bg-[var(--menu-item-hover)]' }
  return menu
    ? <MenuPrimitive.Item {...props} nativeButton closeOnClick={false} render={<Button variant="ghost" size="icon">{children}</Button>}>{children}</MenuPrimitive.Item>
    : <Button {...props} variant="ghost" size="icon">{children}</Button>
}
