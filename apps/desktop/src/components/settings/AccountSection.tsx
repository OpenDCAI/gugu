import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState } from 'react'
import { authService } from '../../lib/auth'
import type { AuthUser } from '../../store/auth'
import { Avatar } from '../Avatar'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { Button } from '../ui/Button'
import { LogOut } from '@/lib/icons'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { useTranslation } from 'react-i18next'
import { OCCUPATION_KEYS, OCCUPATION_OTHER_MAX, occupationComplete, type Occupation } from '@gugu/core/shared/firstRun'
import { readOccupation, writeOccupation } from '../../lib/firstRun'
import '../../i18n/registerMainCatalog'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('settings/account')

interface AccountSectionProps {
  user: AuthUser | null
  updateUser: (user: AuthUser) => void
  logout: () => Promise<{ success: boolean }>
}

export function AccountSection({ user, updateUser, logout }: AccountSectionProps) {
  const { t } = useTranslation('settings')
  const { t: tMain } = useTranslation('main')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)

  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarError, setAvatarError] = useState('')

  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  // 身份(product spec:新账号在「认识你」里填,这里能改)。存在账号设置里、只有本人读得到,不进名片。
  // 读不到 = 这一行如实说读不到、不给改,❌ 当成没填让人覆盖掉原值。
  const [occupation, setOccupation] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; saved: Occupation | null; draft: Occupation | null }>({ kind: 'loading' })
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    readOccupation(user.id)
      .then((saved) => { if (!cancelled) setOccupation({ kind: 'ready', saved, draft: saved }) })
      .catch((e: unknown) => { log.error({ error: e }, 'read occupation failed'); if (!cancelled) setOccupation({ kind: 'error', message: messageForUser(e) }) })
    return () => { cancelled = true }
  }, [user?.id])
  const occupationDirty = occupation.kind === 'ready' && JSON.stringify(occupation.draft) !== JSON.stringify(occupation.saved)
  const occupationInvalid = occupation.kind === 'ready' && occupationDirty && !occupationComplete(occupation.draft)

  const dirty = nickname.trim() !== (user?.nickname ?? '') || (bio ?? '') !== (user?.bio ?? '') || occupationDirty

  async function handleSave() {
    if (!user || !dirty) return
    const trimmedName = nickname.trim()
    // fail loud: 名称必填，空名称不静默跳过(否则会假报「已保存」却没写库)
    if (!trimmedName) { setSaveError(t('account.nameRequired')); return }
    setSaving(true); setSaveError(''); setSaved(false)
    const next = { ...user }
    // 名称
    if (trimmedName !== user.nickname) {
      const res = await authService.updateNickname(user.id, trimmedName)
      if (!res.success) { setSaving(false); setSaveError(res.error ?? t('account.saveFailed')); return }
      next.nickname = trimmedName
    }
    // 简介
    if ((bio ?? '') !== (user.bio ?? '')) {
      const res = await authService.updateBio(user.id, bio)
      if (!res.success) { setSaving(false); setSaveError(res.error ?? t('account.saveFailed')); return }
      next.bio = bio.trim() || null
    }
    // 身份
    if (occupation.kind === 'ready' && occupationDirty) {
      if (!occupationComplete(occupation.draft)) { setSaving(false); setSaveError(t('account.occupationRequired')); return }
      try {
        await writeOccupation(user.id, occupation.draft)
      } catch (e) {
        log.error({ error: e }, 'write occupation failed')
        setSaving(false); setSaveError(messageForUser(e)); return
      }
      setOccupation({ kind: 'ready', saved: occupation.draft, draft: occupation.draft })
    }
    updateUser(next)
    // 同步本地输入到持久值(去空白)→ dirty 归零、显示「已保存」、避免空格 bio 残留脏态
    setNickname(next.nickname)
    setBio(next.bio ?? '')
    setSaving(false)
    setSaved(true)
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return
    setAvatarUploading(true); setAvatarError('')
    const res = await authService.updateAvatar(user.id, file)
    setAvatarUploading(false)
    if (!res.success) { setAvatarError(res.error ?? t('account.uploadFailed')); return }
    updateUser({ ...user, avatarUrl: res.avatarUrl })
    e.target.value = ''
  }

  async function handleLogout() {
    setLoggingOut(true)
    setLogoutError('')
    try {
      await logout()
    } catch (error) {
      log.error({ error }, 'logout failed')
      setLogoutError(messageForUser(error))
      setLoggingOut(false)
    }
  }

  return (
    <SettingsPage data-testid="settings-account">
      <SettingsNote>{t('account.intro')}</SettingsNote>

      {/* Identity summary and labelled editors retain the original save/upload paths. */}
      <SettingsGroup presentation="summary">
        <SettingsRow
          title={user?.nickname ?? t('account.avatar')}
          description={avatarError ? <span style={{ color: 'var(--danger)' }}>{avatarError}</span> : t('account.avatar')}
          leading={(
            // 头像即按钮:ui/Button 的 ghost(键盘可达、读屏读得出),盒子与侧栏头像按钮同一组数。
            <Button
              variant="ghost"
              size="icon"
              className="size-[var(--control-h-touch)] shrink-0 rounded-[var(--radius-xl)] p-0"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              aria-label={t('account.uploadAvatar')}
              title={t('account.uploadAvatar')}
            >
              <span className="gg-avatar-upload-frame">
                <Avatar name={resolveOrLoud(user?.nickname, `account nickname ${user?.id}`)} avatarUrl={user?.avatarUrl} seed={user?.id} size="md" />
                {avatarUploading && (
                  <span className="gg-avatar-upload-busy">
                    <span className="gg-avatar-upload-spinner" />
                  </span>
                )}
              </span>
            </Button>
          )}
        />
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={handleAvatarChange} />
      </SettingsGroup>
      <SettingsGroup presentation="editor">
        <SettingsRow
          stack
          layout="field"
          title={<label htmlFor="settings-account-name">{t('account.name')}</label>}
          control={(
            <input
              id="settings-account-name"
              className="gg-settings-input window-no-drag-region"
              data-field="wide"
              value={nickname}
              onChange={e => { setNickname(e.target.value); setSaved(false) }}
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
            />
          )}
        />
        <SettingsRow
          layout="field"
          title={t('account.email')}
          control={<span className="gg-settings-row-value">{user?.email ?? ''}</span>}
        />
        <SettingsRow
          stack
          layout="field"
          title={<label htmlFor="settings-account-bio">{t('account.bio')}</label>}
          control={(
            <input
              id="settings-account-bio"
              className="gg-settings-input window-no-drag-region"
              data-field="wide"
              value={bio ?? ''}
              onChange={e => { setBio(e.target.value); setSaved(false) }}
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
              placeholder={t('account.bioPlaceholder')}
            />
          )}
        />
        <SettingsRow
          stack
          layout="field"
          title={<label htmlFor="settings-account-occupation">{t('account.occupation')}</label>}
          description={occupation.kind === 'ready' ? t('account.occupationNote') : undefined}
          control={occupation.kind !== 'ready' ? (
            <span className="gg-settings-row-value" role={occupation.kind === 'error' ? 'alert' : undefined}>
              {occupation.kind === 'loading' ? t('account.occupationLoading') : occupation.message}
            </span>
          ) : (
            <span className="flex w-full flex-col gap-2">
              <select
                id="settings-account-occupation"
                className="gg-settings-select"
                data-testid="settings-account-occupation"
                value={occupation.draft?.key ?? ''}
                onChange={(e) => {
                  const key = e.target.value
                  const draft: Occupation | null = !key ? null : key === 'other'
                    ? { key: 'other', text: occupation.draft?.key === 'other' ? occupation.draft.text : '' }
                    : { key: key as (typeof OCCUPATION_KEYS)[number] }
                  setOccupation({ ...occupation, draft }); setSaved(false)
                }}
              >
                {occupation.saved ? null : <option value="">{t('account.occupationUnset')}</option>}
                {[...OCCUPATION_KEYS, 'other' as const].map((key) => (
                  <option key={key} value={key}>{tMain(`firstRun.occupation.${key}`)}</option>
                ))}
              </select>
              {occupation.draft?.key === 'other' ? (
                <input
                  className="gg-settings-input window-no-drag-region"
                  data-field="wide"
                  data-testid="settings-account-occupation-other"
                  maxLength={OCCUPATION_OTHER_MAX}
                  aria-invalid={occupationInvalid || undefined}
                  value={occupation.draft.text}
                  placeholder={tMain('firstRun.otherPlaceholder')}
                  onChange={(e) => { setOccupation({ ...occupation, draft: { key: 'other', text: e.target.value } }); setSaved(false) }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
                />
              ) : null}
            </span>
          )}
        />
      </SettingsGroup>

      {/* 保存:靠右一行,状态(失败 / 已保存)在按钮左边。 */}
      <div className="gg-settings-actions">
        {saveError && <span role="alert" className="gg-settings-actions-note" data-tone="danger">{saveError}</span>}
        {saved && !dirty && <span className="gg-settings-actions-note">{t('account.saved')}</span>}
        <Button variant="primary" size="md" onClick={() => { void handleSave() }} disabled={saving || !dirty}>
          {saving ? t('account.saving') : t('account.save')}
        </Button>
      </div>

      {/* Account-wide action stays below the editor and its save feedback. */}
      <SettingsGroup
        presentation="danger"
        footer={logoutError ? <SettingsNote tone="danger" role="alert">{logoutError}</SettingsNote> : undefined}
      >
        <SettingsRow
          title={t('account.logout')}
          description={t('account.logoutNote')}
          control={(
            <Button variant="ghost" size="sm" onClick={() => { void handleLogout() }} disabled={loggingOut} style={{ color: 'var(--danger)' }}>
              <LogOut size={15} />
              {loggingOut ? t('account.loggingOut') : t('account.logout')}
            </Button>
          )}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
