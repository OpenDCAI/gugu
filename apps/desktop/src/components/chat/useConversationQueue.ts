import { messageForUser } from '@/lib/userFacingError'
import { useEffect, useRef, useState } from 'react'
import type { SessionpageQueueAction } from '@gugu/session-core/session-record/contract'
import type { ComposerQueuedPrompt } from '@gugu/session-ui/react/components'
import { changeConversationQueue } from '../assistant/assistantTimelineClient'
import { requestSendQueuedPromptNow } from '@renderer/features/sessions/acp/send-queued-prompt-now-flow'

type Target = { deviceId: string; sessionId: string; local: boolean; phoneHost?: boolean }
type Editing = { id: string; text: string; originalDraftText: string }

export function useConversationQueue(target: Target | null,
  prompts: readonly { id: string; text: string; queueEdit?: { draftText: string; originalDraftText: string } }[], working: boolean, steers = false) {
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  const sequence = useRef(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftWrite = useRef<SessionpageQueueAction | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const remoteEdit = prompts.find(prompt => prompt.queueEdit)
  useEffect(() => {
    if (!remoteEdit) setEditing(null)
    else setEditing(current => current?.id === remoteEdit.id ? current : { id: remoteEdit.id, text: remoteEdit.queueEdit!.draftText, originalDraftText: remoteEdit.queueEdit!.originalDraftText })
  }, [remoteEdit])

  // Serialize autosaves and the final edit: a late autosave must never reserve an already-sent entry again.
  const change = (action: SessionpageQueueAction, blocking = true) => {
    if (blocking && mounted.current) setPending(true)
    const result = sequence.current.then(async () => {
      if (!target) throw new Error('This conversation has no authorized runtime queue')
      await changeConversationQueue(target.local, target.deviceId, target.sessionId, action, target.phoneHost)
    }).then(() => {
      if (mounted.current) setError(null)
      return true
    }, cause => {
      if (mounted.current) setError(messageForUser(cause))
      return false
    }).finally(() => { if (blocking && mounted.current) setPending(false) })
    sequence.current = result.then(() => undefined)
    return result
  }
  const flushDraft = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const action = draftWrite.current
    draftWrite.current = null
    if (action) void change(action, false)
  }
  const flushRef = useRef(flushDraft)
  flushRef.current = flushDraft
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; flushRef.current() }
  }, [])

  return {
    error,
    props: {
      queuedPrompts: prompts.map(prompt => ({ ...prompt, origin: 'manual' as const, sendNowSteers: steers })) as ComposerQueuedPrompt[],
      onEditQueuedPrompt: (id: string, text: string) => { void change({ kind: 'edit', id, text }) },
      queuedPromptEdit: editing ? { ...editing, pending } : null,
      onBeginEditQueuedPrompt: (id: string, originalDraftText = '') => {
        if (pending || editingRef.current) return
        const prompt = prompts.find(item => item.id === id)
        if (prompt) void change({ kind: 'edit', id, text: prompt.text, queueEdit: { draftText: prompt.text, originalDraftText } })
          .then(saved => { if (saved && mounted.current) setEditing({ id, text: prompt.text, originalDraftText }) })
      },
      onChangeQueuedPromptEdit: (text: string) => {
        const edit = editingRef.current
        const prompt = prompts.find(item => item.id === edit?.id)
        if (!edit || !prompt || pending) return
        const next = { ...edit, text }
        editingRef.current = next
        setEditing(next)
        draftWrite.current = { kind: 'edit', id: edit.id, text: prompt.text, queueEdit: { draftText: text, originalDraftText: edit.originalDraftText } }
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(flushDraft, 300)
      },
      onFinishQueuedPromptEdit: (text: string | null) => {
        const edit = editingRef.current
        const prompt = prompts.find(item => item.id === edit?.id)
        if (!edit || !prompt || pending || (text !== null && !text.trim())) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
        draftWrite.current = null
        void change({ kind: 'edit', id: edit.id, text: text ?? prompt.text, queueEdit: null })
          .then(saved => { if (saved && mounted.current) setEditing(null) })
      },
      onDeleteQueuedPrompt: (id: string) => { void change({ kind: 'delete', id }) },
      onReorderQueuedPrompts: (ids: string[]) => { void change({ kind: 'reorder', ids }) },
      onSendQueuedPromptNow: (id: string) => requestSendQueuedPromptNow({ cancelsTurn: working && !steers,
        send: () => { void change({ kind: 'send-now', id, steers }) } }),
    },
  }
}
