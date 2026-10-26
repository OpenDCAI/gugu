import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../Avatar'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Button'
import { messageForUser } from '../../lib/userFacingError'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

// The same editor serves private contact and group display overrides on every shell.
export function AliasSheet({ name, alias, avatarUrl, seed, group = false, onSave, onClose }: {
  name: string; alias?: string | null; avatarUrl?: string | null; seed: string; group?: boolean
  onSave: (alias: string) => Promise<void>; onClose: () => void
}) {
  const { t } = useTranslation('contacts')
  const saved = alias?.trim() ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (saving) return
    const next = draft.trim()
    if (next === saved) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(next)
      onClose()
    } catch (err) {
      setError(messageForUser(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      onClose={onClose}
      ariaLabel={t('contextMenu.setAlias')}
      testId={AUTOMATION_TEST_IDS.contactAliasSheet}
      desktopWidth="min(400px, 100%)"
    >
      <div className="flex flex-col gap-4 px-5 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <Avatar name={name} avatarUrl={avatarUrl} seed={seed} variant={group ? 'group' : undefined} size="md" />
          <div className="min-w-0">
            <div className="truncate text-[length:var(--font-title)] leading-[var(--lh-title)] font-semibold text-[var(--text-primary)]">{name}</div>
            <div className="text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-tertiary)]">{t('contextMenu.setAlias')}</div>
          </div>
        </div>
        <input
          data-testid={AUTOMATION_TEST_IDS.contactAliasSheetInput}
          className="box-border h-[var(--control-h-xl)] w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-transparent px-3 py-0 text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-primary)] outline-none [font-family:inherit] placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] max-[719px]:h-[var(--control-h-touch)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          placeholder={t('profile.notSet')}
          maxLength={80}
          autoFocus
          disabled={saving}
        />
        {error ? <div role="alert" className="text-sm text-[var(--danger)]">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid={AUTOMATION_TEST_IDS.contactAliasSheetSave}
            onClick={() => void save()}
            disabled={saving}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
