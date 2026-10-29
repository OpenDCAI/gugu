import { useEffect, useRef, useState } from 'react'
import type { MessageTextSelection } from '../lib/messageTextSelection'
import { bindMessageTextSelection, type SelectionAction } from '../lib/bindMessageTextSelection'
import { hasNativeMessageSelection } from '../platform/capacitorMessageSelection'

export type { SelectionAction } from '../lib/bindMessageTextSelection'
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
    return bindMessageTextSelection(root, {
      enabled: true,
      onQuote: (text, id) => latest.current.onQuote(text, id),
      onClearQuote: id => latest.current.onClearQuote(id),
      actions: text => latest.current.actions(text),
      onContext: setSelection,
    })
  }, [root, options.enabled, native])
  return { ref: options.enabled ? setRoot : undefined, selection: options.enabled && !native ? selection : null, root, actions: selection ? options.actions(selection.text) : [] }
}
