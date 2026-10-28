import { useEffect, useRef, useState } from 'react'
import { observeMessageTextSelection, type MessageTextSelection } from '../lib/messageTextSelection'
import { clearNativeMessageSelection, hasNativeMessageSelection, publishNativeMessageSelection } from '../platform/capacitorMessageSelection'

export interface SelectionAction {
  key: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect?: () => void
}
interface Options {
  enabled: boolean
  onQuote: (text: string, selectionId: string) => void
  onClearQuote: (selectionId: string) => void
  actions: (text: string) => readonly SelectionAction[]
}

/** No message model or Markdown dependency: any renderer can provide its own text root and callbacks. */
export function useMessageTextSelection(options: Options) {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [selection, setSelection] = useState<MessageTextSelection | null>(null)
  const latest = useRef(options)
  latest.current = options
  const native = hasNativeMessageSelection()
  useEffect(() => {
    if (!root || !options.enabled) return
    let contextId: string | null = null
    return observeMessageTextSelection(root, {
      enabled: true,
      onQuote: (text, id) => latest.current.onQuote(text, id),
      onClearQuote: id => latest.current.onClearQuote(id),
      onContext: next => {
        if (native) {
          if (next) publishNativeMessageSelection(next.selectionId, latest.current.actions(next.text))
          else if (contextId) clearNativeMessageSelection(contextId)
        } else setSelection(next)
        contextId = next?.selectionId ?? null
      },
    })
  }, [root, options.enabled, native])
  return { ref: options.enabled ? setRoot : undefined, selection: options.enabled && !native ? selection : null, root, actions: selection ? options.actions(selection.text) : [] }
}
