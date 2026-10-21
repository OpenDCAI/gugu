import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'

/** Edits the agent identity, independently of task titles, local aliases and group roles. */
export function OwnedAgentNameEditor({ agentId, name, ownerUserId, status, membership }: {
  agentId: string
  name: string
  ownerUserId?: string | null
  status?: AgentDisplayStatus
  membership?: string
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { renameAgent } = useContactsStore()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  if (!user?.id || ownerUserId !== user.id || status === 'removed' || membership === 'removed') return null

  const cancel = () => {
    if (pending.current) return
    setDraft(null)
    setError(null)
  }
  const save = async () => {
    if (draft === null || pending.current) return
    const next = draft.trim()
    if (!next) { setError(t('errors.nameRequired')); return }
    // A failed local publication may follow a successful cloud write; allow retrying the same name.
    if (next === name && !error) { cancel(); return }
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      await renameAgent(agentId, next)
      setDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('agentName.failed'))
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  if (draft === null) return (
    <Button variant="ghost" size="sm" className="self-start" onClick={() => setDraft(name)}>
      {t('agentName.edit')}
    </Button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-2" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
    }}>
      <Field.Root invalid={!!error}>
        <Field.Label>{t('agentName.label')}</Field.Label>
        <Field.Input
          autoFocus
          value={draft}
          disabled={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save() }
          }}
        />
        {error && <div role="alert" className="text-[length:var(--font-body)] text-[var(--danger)]">{error}</div>}
      </Field.Root>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>{t(saving ? 'agentName.saving' : 'common.save')}</Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={cancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  )
}
