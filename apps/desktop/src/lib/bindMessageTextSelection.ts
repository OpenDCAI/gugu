import { observeMessageTextSelection, type MessageTextSelection, type MessageTextSelectionOptions } from './messageTextSelection'
import { clearNativeMessageSelection, hasNativeMessageSelection, publishNativeMessageSelection } from '../platform/capacitorMessageSelection'

export interface SelectionAction {
  key: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect?: () => void
}

/** Bind any renderer's body root; the native bridge and selection lifecycle have one implementation. */
export function bindMessageTextSelection(root: HTMLElement, options: Omit<MessageTextSelectionOptions, 'onContext'> & {
  actions: (text: string) => readonly SelectionAction[]
  onContext: (selection: MessageTextSelection | null) => void
}): () => void {
  if (!options.enabled) return () => {}
  const native = hasNativeMessageSelection()
  const oldStyle = [root.style.userSelect, root.style.getPropertyValue('-webkit-user-select'), root.style.getPropertyValue('-webkit-touch-callout')] as const
  root.style.userSelect = 'text'
  root.style.setProperty('-webkit-user-select', 'text')
  root.style.setProperty('-webkit-touch-callout', 'default')
  let contextId: string | null = null
  const dispose = observeMessageTextSelection(root, { ...options, onContext: next => {
    if (native) {
      if (next) publishNativeMessageSelection(next.selectionId, options.actions(next.text))
      else if (contextId) clearNativeMessageSelection(contextId)
    } else options.onContext(next)
    contextId = next?.selectionId ?? null
  } })
  return () => {
    dispose()
    root.style.userSelect = oldStyle[0]
    root.style.setProperty('-webkit-user-select', oldStyle[1])
    root.style.setProperty('-webkit-touch-callout', oldStyle[2])
  }
}
