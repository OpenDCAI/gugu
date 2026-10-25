import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Check, Pencil, X } from '@/lib/icons'
import { ASSISTANT_NAME_MAX } from '../../lib/assistantSetup'
import { cn } from '../../lib/cn'
import './assistant-name-inline.css'

/** 名字原位编辑；默认点击/失焦保存，设置标题双击并显式保存；失败保留草稿。 */
export function AssistantNameInline({ name, onCommit, className, activation = 'click' }: {
  name: string
  onCommit: (name: string) => Promise<void>
  className?: string
  /** Settings title uses double-click text or a pencil, with explicit save/cancel. */
  activation?: 'click' | 'double-click'
}) {
  const { t } = useTranslation('assistant')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState('')
  const committing = useRef(false)
  const ignoreBlur = useRef(false)

  const commit = async () => {
    if (committing.current || ignoreBlur.current) return
    const next = draft.trim()
    if (!next || next === name) { setEditing(false); return }
    committing.current = true
    setSaving(true)
    setFailed('')
    try {
      await onCommit(next)
      setEditing(false)
    } catch (error) {
      rendererLogger('actions/AssistantNameInline').error({ error }, 'action failed'); setFailed(messageForUser(error))
    } finally {
      committing.current = false
      setSaving(false)
    }
  }

  const startEditing = () => { ignoreBlur.current = false; setDraft(name); setFailed(''); setEditing(true) }
  const cancel = () => { if (!committing.current) { ignoreBlur.current = true; setFailed(''); setEditing(false) } }

  return (
    <span className={cn('assistant-name-inline', className)}>
      {editing ? (
        <span className="assistant-name-editor">
          <input
            autoFocus
            className="assistant-name-input window-no-drag-region"
            aria-label={t('settingsPage.name')}
            aria-invalid={!!failed || undefined}
            value={draft}
            maxLength={ASSISTANT_NAME_MAX}
            readOnly={saving}
            aria-busy={saving || undefined}
            onChange={(event) => { setDraft(event.target.value); setFailed('') }}
            onBlur={activation === 'click' ? () => void commit() : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') { event.preventDefault(); void commit() }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                cancel()
              }
            }}
            data-testid="assistant-name-input"
          />
          {activation === 'double-click' ? <>
            <IconButton size="sm" aria-label={t('settingsPage.save')} data-testid="assistant-name-save" disabled={saving || !draft.trim() || draft.trim() === name} onClick={() => void commit()}><Check size={16} /></IconButton>
            <IconButton size="sm" aria-label={t('common.cancel')} disabled={saving} onClick={cancel}><X size={16} /></IconButton>
          </> : null}
        </span>
      ) : activation === 'double-click' ? (
        <span className="assistant-name-title">
          <span className="assistant-name-text" onDoubleClick={startEditing} title={t('settingsPage.editName', { name })} data-testid="assistant-name-display">{name}</span>
          <IconButton size="sm" aria-label={t('settingsPage.editName', { name })} onClick={startEditing} data-testid="assistant-name-edit"><Pencil size={16} /></IconButton>
        </span>
      ) : (
        <Button
          variant="ghost"
          className="assistant-name-display"
          onClick={startEditing}
          aria-label={t('settingsPage.editName', { name })}
          data-testid="assistant-name-edit"
        >{name}</Button>
      )}
      {failed ? <span className="assistant-name-error" role="alert">{failed}</span> : null}
    </span>
  )
}
