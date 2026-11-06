import { useEffect, useRef, type RefObject } from 'react'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { findMentionSpans } from '@gugu/core/shared/mentionToken.mjs'
import { markdownMentionReferences } from '@gugu/session-shared/markdown/dialect'
import type { MentionCandidate } from '@/lib/mention'
import type { MentionTarget } from './useChatDraft'

/** Draft persistence already retains selected IDs; restore their object presentation without changing text. */
export function useRestoreSelectedAgentMentions(editor: RefObject<PromptEditorRef | null>, text: string,
  targets: MentionTarget[], members: MentionCandidate[], enabled: boolean) {
  const initial = useRef<{ api: PromptEditorRef; text: string; done: boolean } | null>(null)
  useEffect(() => {
    if (!enabled || !editor.current) return
    const api = editor.current
    if (initial.current?.api !== api) initial.current = { api, text, done: false }
    const pending = initial.current
    if (pending.done) return
    // Restoration belongs to hydration. A user's edit must keep the active picker and caret.
    if (api.getText() !== pending.text) { pending.done = true; return }
    const selected = targets.flatMap(target => {
      const member = members.find(candidate => candidate.id === target.userId && candidate.type === 'agent')
      return member ? [{ target, member }] : []
    })
    if (!selected.length) return
    const value = api.getText()
    const canonical = markdownMentionReferences(value)
    const references = findMentionSpans(value, selected.map(({ target }) => target.displayName)).flatMap(span => {
      if (canonical.some(ref => span.start < ref.end && span.end > ref.start)) return []
      const matches = selected.filter(({ target }) => target.displayName === span.name)
      // A bare label identifies an object only when its saved selection is unambiguous.
      // Normal same-name selections already use canonical aid: references and keep their own atoms.
      if (matches.length !== 1) return []
      const { member } = matches[0]
      return [{ start: span.start, end: span.end, item: { id: member.id, label: span.name, name: span.name,
        role: 'agent' as const, kind: 'custom' as const } }]
    })
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || pending.done || api.getText() !== pending.text) return
      pending.done = true
      api.restoreMentions(references)
    })
    return () => { cancelled = true }
  }, [editor, text, targets, members, enabled])
}
