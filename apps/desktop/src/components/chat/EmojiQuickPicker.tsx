import { motion } from 'framer-motion'
import type { KeyboardEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from '../ui/Popover'
import { REACTIONS, reactionLabel } from '@gugu/core/shared/ui/reactionCatalog'

interface EmojiQuickPickerProps {
  /** The button that opened the picker; Base UI keeps the picker attached to it while the list moves. */
  anchor: Element | RefObject<Element | null>
  onPick: (emoji: string) => void
  onClose: () => void
}

/** Keyboard-accessible quick reactions anchored to the message action button. */
export function EmojiQuickPicker({ anchor, onPick, onClose }: EmojiQuickPickerProps) {
  const { t, i18n } = useTranslation('messaging')

  const handleToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    if (!buttons.length) return
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <Popover.Root open modal={false} onOpenChange={(open) => { if (!open) onClose() }}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <Popover.Popup
            // @@@float-one-edge (Refs #6104) — 与 ui/Menu 同一条:浮层只留 lift,不叠描边。
            className="box-border overflow-hidden rounded-[var(--radius-surface)] bg-[var(--menu-bg)] text-[var(--menu-fg)] shadow-[var(--shadow-menu)]"
            role="toolbar"
            aria-label={t('emoji.quickReactions')}
            onKeyDown={handleToolbarKeyDown}
            style={{ display: 'grid', gap: '2px', padding: '4px 6px' }} // #6562 表态一行、带工作含义的一行(按目录的 kind 分行)
          >
            {REACTIONS.map(({ emoji, kind }) => (
              <motion.button
                key={emoji}
                type="button" title={reactionLabel(emoji, i18n.language) ?? undefined}
                aria-label={t('emoji.reactWith', { emoji: `${emoji} ${reactionLabel(emoji, i18n.language) ?? ''}`.trim() })}
                onClick={(event) => { event.stopPropagation(); onPick(emoji); onClose() }}
                whileTap={{ scale: 0.85 }}
                whileHover={{ scale: 1.15 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                style={{
                  background: 'none', gridRow: kind === 'mood' ? 1 : 2,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '18px',
                  padding: '2px',
                  borderRadius: 'var(--radius-document)',
                }}
              >
                {emoji}
              </motion.button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
