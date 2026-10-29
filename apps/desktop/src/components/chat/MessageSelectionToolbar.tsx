import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import type { SelectionAction } from '../../hooks/useMessageTextSelection'

/** Mobile web keeps the browser's handles; this transient companion must not focus away from the range. */
export function MessageSelectionToolbar({ root, actions }: { root: HTMLElement; actions: readonly SelectionAction[] }) {
  const { t } = useTranslation('messaging')
  const clear = () => root.ownerDocument.getSelection()?.removeAllRanges()
  return <Popover.Root open modal={false} onOpenChange={open => { if (!open) clear() }}>
    <Popover.Portal>
      <Popover.Positioner anchor={root} side="bottom" align="start" sideOffset={8} collisionPadding={8}>
        <Popover.Popup role="toolbar" aria-label={t('message.actions.more')} data-testid="message-selection-toolbar"
          initialFocus={false} finalFocus={false} onPointerDown={event => event.preventDefault()}
          className="flex max-w-[calc(100vw-16px)] flex-wrap gap-1 rounded-[var(--radius-surface)] bg-[var(--menu-bg)] p-1 text-[length:var(--font-body)] text-[var(--menu-fg)] shadow-[var(--shadow-lift)]">
          {actions.map(item => <Button key={item.key} variant="ghost" size="sm" disabled={item.disabled} data-testid={`message-selection-${item.key}`}
            style={item.danger ? { color: 'var(--danger)' } : undefined}
            onClick={() => { item.onSelect?.(); clear() }}>{item.label}</Button>)}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
