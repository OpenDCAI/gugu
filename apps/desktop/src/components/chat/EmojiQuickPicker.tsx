import { useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useTranslation } from 'react-i18next'
import { FrequentlyUsed } from 'emoji-mart'
import data, { type EmojiMartData } from '@emoji-mart/data'
import { QUICK_REACTIONS, REACTIONS, reactionLabel } from '@gugu/core/shared/ui/reactionCatalog'
import { Plus } from '@/lib/icons'
import { Popover } from '../ui/Popover'
import { Button } from '../ui/Button'
import { DeferredEmojiPickerPanel } from './messageActionModules'

// emoji-mart 5.6 的运行时导出 get,类型生成物却写成 _get1。只收窄这一个已存在的接口。
const frequent = FrequentlyUsed as typeof FrequentlyUsed & { get(options: { maxFrequentRows: number; perLine: number }): string[] }
// 不把库自带的示例当成用户记录;空记录时的六个按钮由唯一目录补齐。
frequent.DEFAULTS.splice(0)
const emojiData = data as unknown as EmojiMartData
const emojiIds = new Map(Object.values(emojiData.emojis).flatMap((entry) => entry.skins.map(({ native }) => [native, entry.id] as const)))

/** 桌面回应浮层与手机长按面板共用:一行常用 + 完整选择器,在原面板内切换。 */
export function EmojiQuickPicker({ anchor, onPick, onClose, children, disabled = false, menu = false }: {
  anchor?: Element | RefObject<Element | null>
  onPick: (emoji: string) => void
  onClose: () => void
  children?: ReactNode
  disabled?: boolean
  menu?: boolean
}) {
  const { t, i18n } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const emojis = [...new Set([...frequent.get({ maxFrequentRows: 2, perLine: 9 }).slice(0, 6).map((id) => emojiData.emojis[id].skins[0].native), ...QUICK_REACTIONS.map(({ emoji }) => emoji)])].slice(0, 6)
  const pick = (emoji: string) => { onPick(emoji); onClose() }
  const pickQuick = (emoji: string) => { frequent.add({ id: emojiIds.get(emoji)! }); pick(emoji) }
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
          {REACTIONS.filter(({ kind }) => kind === 'status').map(({ emoji }) => <Button key={emoji} variant="ghost" onClick={() => pickQuick(emoji)}><span className="text-xl">{emoji}</span>{reactionLabel(emoji, i18n.language)}</Button>)}
        </div>
      </section>
      <DeferredEmojiPickerPanel onSelect={pick} />
    </>
  ) : (
    <>
      <div role={menu ? 'group' : 'toolbar'} aria-label={t('emoji.quickReactions')} onKeyDown={handleToolbarKeyDown} className="grid grid-cols-7 justify-items-center pb-2">
        {emojis.map((emoji) => <QuickReactionButton key={emoji} menu={menu} title={reactionLabel(emoji, i18n.language) ?? emoji} label={t('emoji.reactWith', { emoji: `${emoji} ${reactionLabel(emoji, i18n.language) ?? ''}`.trim() })} onClick={() => pickQuick(emoji)}>{emoji}</QuickReactionButton>)}
        <QuickReactionButton menu={menu} label={t('emoji.moreReactions')} onClick={() => setExpanded(true)}><Plus size={20} /></QuickReactionButton>
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
    ? <MenuPrimitive.Item {...props} nativeButton closeOnClick={false} render={<Button variant="ghost" size="icon" />}>{children}</MenuPrimitive.Item>
    : <Button {...props} variant="ghost" size="icon">{children}</Button>
}
