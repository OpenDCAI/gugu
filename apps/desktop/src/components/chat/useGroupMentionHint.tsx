import { useState, type KeyboardEvent, type RefObject } from 'react'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { ArrowRight } from '@/lib/icons'
import { useGroupMentionRecall } from '@/lib/groupMentionRecall'
import type { MentionCandidate } from '@/lib/mention'
import { mentionMatchScore } from '@/lib/mentionMatch'

/** A placeholder action only: accepting it uses exactly the member picker's editor command. */
export function useGroupMentionHint({ accountId, chatId, members, text, enabled, editor, input }: {
  accountId?: string | null; chatId?: string | null; members: MentionCandidate[]; text: string; enabled: boolean
  editor: RefObject<PromptEditorRef | null>; input: RefObject<HTMLElement | null>
}) {
  const targetId = useGroupMentionRecall(enabled ? accountId : null, chatId)
  const [composing, setComposing] = useState(false)
  const target = enabled && text === '' && !composing ? members.find((member) => member.id === targetId && member.type === 'agent' && mentionMatchScore(member, '') > 0) : undefined
  const accept = () => {
    if (!target || !editor.current?.isEmpty() || input.current?.getAttribute('aria-expanded') === 'true') return false
    editor.current.insertMention({ id: target.id, label: target.name, name: target.name, role: 'agent', kind: 'custom' })
    return true
  }
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.target !== input.current || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowRight', 'Tab'].includes(event.key)) return
    if (accept()) { event.preventDefault(); event.stopPropagation() }
  }
  return {
    onKeyDownCapture,
    onCompositionStartCapture: () => setComposing(true),
    onCompositionEndCapture: () => setComposing(false),
    hint: target ? <button type="button" data-testid="group-mention-hint"
      className="group-mention-hint" onMouseDown={(event) => event.preventDefault()} onClick={accept}>
      <span className="group-mention-hint-name">@{target.name}</span><kbd aria-hidden="true"><ArrowRight size={14} /></kbd>
    </button> : undefined,
  }
}
