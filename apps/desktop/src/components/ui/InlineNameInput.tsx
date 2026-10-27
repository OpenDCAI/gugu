import { useState } from 'react'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'

/** The shared edit phase for group/topic names and personal aliases. */
export function InlineNameInput({ name, onCommit, onClose, placeholder, allowEmpty = false, maxLength, testId }: {
  name: string
  onCommit: (next: string) => Promise<void>
  onClose: () => void
  placeholder?: string
  allowEmpty?: boolean
  maxLength?: number
  testId?: string
}) {
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const commit = async () => {
    if (busy) return
    const next = draft.trim()
    if ((!allowEmpty && !next) || next === name) { onClose(); return }
    setBusy(true)
    setFailed('')
    try {
      await onCommit(next)
      onClose()
    } catch (error) {
      rendererLogger('actions/InlineNameInput').error({ error }, 'action failed')
      setFailed(messageForUser(error))
    } finally {
      setBusy(false)
    }
  }
  return <input
    autoFocus
    data-testid={testId}
    value={draft}
    maxLength={maxLength}
    onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); void commit() }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}
    onBlur={() => void commit()}
    placeholder={placeholder}
    aria-invalid={!!failed || undefined}
    data-rename-failed={failed ? 'true' : undefined}
    title={failed || undefined}
    style={{
      border: 'none', fontSize: 'var(--font-heading)', fontWeight: 600,
      background: 'transparent', outline: 'none', width: '100%',
      color: failed ? 'var(--danger)' : 'var(--text-primary)', padding: 0,
    }}
  />
}
