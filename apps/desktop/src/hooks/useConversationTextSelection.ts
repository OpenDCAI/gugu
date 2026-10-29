import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ChatCommands, ChatMessage } from '@gugu/session-chat-ui'
import { bindMessageTextSelection, type SelectionAction } from '../lib/bindMessageTextSelection'
import type { MessageTextSelection } from '../lib/messageTextSelection'
import { MessageSelectionToolbar } from '../components/chat/MessageSelectionToolbar'

type Target = Parameters<NonNullable<ChatCommands['onMessageTextMount']>>[0]
interface Options {
  enabled: boolean
  onQuote: (message: ChatMessage, text: string, selectionId: string) => void
  onClearQuote: (selectionId: string) => void
  actions: (message: ChatMessage, text: string) => readonly SelectionAction[]
  canSelect?: (message: ChatMessage) => boolean
}

/** React hosts can bind Solid/virtual transcript roots without depending on their Markdown implementation. */
export function useConversationTextSelection(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const cleanups = useRef(new Set<() => void>())
  const [active, setActive] = useState<{ target: Target; selection: MessageTextSelection } | null>(null)
  useEffect(() => { const owned = cleanups.current; return () => { for (const cleanup of owned) cleanup() } }, [])
  const onMessageTextMount = useCallback((target: Target) => {
    if (latest.current.canSelect?.(target.message()) === false) return () => {}
    const dispose = bindMessageTextSelection(target.root, {
      enabled: latest.current.enabled,
      onQuote: (text, id) => latest.current.onQuote(target.message(), text, id),
      onClearQuote: id => latest.current.onClearQuote(id),
      actions: text => latest.current.actions(target.message(), text),
      onContext: selection => setActive(current => selection ? { target, selection } : current?.target === target ? null : current),
    })
    const cleanup = () => { dispose(); cleanups.current.delete(cleanup) }
    cleanups.current.add(cleanup)
    return cleanup
  }, [])
  return {
    onMessageTextMount: options.enabled ? onMessageTextMount : undefined,
    toolbar: active ? createElement(MessageSelectionToolbar, { root: active.target.root, actions: options.actions(active.target.message(), active.selection.text) }) : null,
  }
}
