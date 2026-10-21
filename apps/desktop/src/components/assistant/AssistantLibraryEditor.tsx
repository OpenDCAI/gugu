import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../session/renderer/lib/ui/input'
import { Textarea } from '../../session/renderer/lib/ui/textarea'
import { Button } from '../ui/Button'
import { PageHead } from '../../session/renderer/features/assistant/assistant-ui-parts'
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import type { UserLibraryEntry, UserLibraryKind } from '../../session/shared/user-library'
import { libraryHost } from './assistant-library-client'

export function AssistantLibraryEditor({ machine, kind, entry, onClose, onSaved }: {
  machine: AssistantMachine | null | undefined; kind: UserLibraryKind; entry: UserLibraryEntry | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation('assistant')
  const [name, setName] = useState(entry?.name ?? '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [group, setGroup] = useState(entry?.group ?? '')
  const [content, setContent] = useState(entry?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  return <form className="ta-page" data-testid="assistant-library-editor" onSubmit={async event => {
    event.preventDefault(); if (!name.trim() || saving) return
    setSaving(true); setFailed(false)
    try {
      await libraryHost(machine)!.writeUserLibraryEntry({ kind, name: name.trim(), description, group: group.trim() || null, content,
        ...(entry ? { id: entry.id, expectedModifiedAt: entry.modifiedAt } : {}) })
      onSaved()
    } catch { setFailed(true) }
    finally { setSaving(false) }
  }}>
    <PageHead title={t(entry ? 'library.edit' : 'library.add')} />
    <label>{t('library.entryName')}<Input autoFocus value={name} onChange={e => setName(e.target.value)} required /></label>
    <label>{t('library.entryGroup')}<Input value={group} onChange={e => setGroup(e.target.value)} /></label>
    <label>{t('library.entryDescription')}<Input value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>{t('library.entryContent')}<Textarea rows={8} value={content} onChange={e => setContent(e.target.value)} /></label>
    <p className="ta-page-sub">{t('library.noCredentials')}</p>
    {failed && <p role="alert">{t('library.saveFailed')}</p>}
    <div className="flex gap-2"><Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
      <Button type="submit" disabled={saving || !name.trim()}>{t(saving ? 'common.saving' : 'common.save')}</Button></div>
  </form>
}
