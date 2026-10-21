import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from '../Avatar'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Button'
import { useContactsStore } from '../../store/contactsContext'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

// #5645 右键菜单「设置备注」的输入弹窗。几何与文案对齐 AddFriendSearch 的附言 Sheet；
// 保存走 contacts store 的 updateContactAlias（同资料卡内联编辑、MemberProfilePopover 一条路）。
export function ContactAliasSheet({ contact, onClose }: { contact: ContactUser; onClose: () => void }) {
  const { t } = useTranslation('contacts')
  const { updateContactAlias } = useContactsStore()
  const saved = contact.alias?.trim() ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    const next = draft.trim()
    if (next === saved) { onClose(); return }
    setSaving(true)
    try {
      await updateContactAlias(contact.id, next)
      onClose()
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
          <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="md" />
          <div className="min-w-0">
            <div className="truncate text-[length:var(--font-title)] leading-[var(--lh-title)] font-semibold text-[var(--text-primary)]">{contact.display_name}</div>
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
