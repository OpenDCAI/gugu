import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createContactQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { useAuth } from '../../store/auth'
import { GUGU_ANDROID_DOWNLOAD_URL } from '../../lib/appLinks'
import { SharePosterDialog, type SharePosterDialogProps } from '../SharePosterDialog'
import { Button } from '../ui/Button'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { MenuItem } from '../ui/Menu'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { UserPlus } from '@/lib/icons'
import '../../i18n/registerMainCatalog'

// Review-only surfaces. A production build cannot enable this preview.
const enabled = import.meta.env.DEV && import.meta.env.VITE_REFERRAL_ENTRY_PREVIEW === '1'

export function ReferralProposalLabel() {
  const { t } = useTranslation('main')
  return (
    <span className="text-[length:var(--font-caption)] font-normal text-[var(--muted-fg)]">
      {t('referralPreview.proposal')}
    </span>
  )
}

function InvitationUnavailable() {
  const { t } = useTranslation('main')
  return (
    <div className="flex flex-col gap-5 p-5" data-testid="referral-preview-unavailable">
      <div>
        <h2 className="m-0 text-[length:var(--font-title)] font-semibold">
          {t('referralPreview.invite')}
        </h2>
        <p className="mb-0 mt-2 text-[length:var(--font-body)] text-[var(--muted-fg)]">
          {t('referralPreview.summary')}
        </p>
      </div>
      <div className="rounded-[var(--radius-surface)] border border-[var(--border-subtle)] p-4">
        <div className="flex items-center justify-between gap-3 text-[length:var(--font-body)]">
          <span>{t('referralPreview.code')}</span>
          <span className="text-[var(--muted-fg)]">{t('referralPreview.disconnected')}</span>
        </div>
        <p className="mb-0 mt-3 text-[length:var(--font-caption)] text-[var(--muted-fg)]">
          {t('referralPreview.backendNote')}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled>
          {t('referralPreview.copyCode')}
        </Button>
        <Button variant="primary" className="flex-1" disabled>
          {t('referralPreview.copyLink')}
        </Button>
      </div>
      <p className="m-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]">
        {t('referralPreview.socialNote')}
      </p>
    </div>
  )
}

/** Both entry points use the existing QR sheet; other people's cards stay unchanged. */
export function PersonalSharePreview({
  initialPurpose = 'contact',
  ...props
}: SharePosterDialogProps & { initialPurpose?: 'invite' | 'contact' }) {
  const { t } = useTranslation('main')
  const [purpose, setPurpose] = useState<'invite' | 'contact'>(initialPurpose)
  if (!enabled) return <SharePosterDialog {...props} />
  return (
    <SharePosterDialog
      {...props}
      heading={t('referralPreview.sharePurpose')}
      headerContent={
        <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
          <ReferralProposalLabel />
          <SegmentedTabs<'invite' | 'contact'>
            ariaLabel={t('referralPreview.sharePurpose')}
            items={[
              { value: 'invite', label: t('referralPreview.invite') },
              { value: 'contact', label: t('referralPreview.myCard') }
            ]}
            value={purpose}
            onChange={setPurpose}
          />
        </div>
      }
      previewContent={
        purpose === 'invite' ? (
          <InvitationUnavailable />
        ) : !props.qrValue ? (
          <p className="p-5 text-[var(--muted-fg)]" role="status">
            {t('referralPreview.noNumber')}
          </p>
        ) : undefined
      }
    />
  )
}

export function ReferralSharePreview({ onClose, zIndex }: { onClose: () => void; zIndex?: string }) {
  const { user } = useAuth()
  const { t } = useTranslation('main')
  const number = user?.gugu_number
  // The actual contact QR is optional; never invent an identity for the review.
  const qrValue =
    typeof number === 'number' && Number.isInteger(number) && number > 0
      ? createGuguQrScanUrl(createContactQrPayload(number), {
          downloadUrl: GUGU_ANDROID_DOWNLOAD_URL
        })
      : ''
  return (
    <PersonalSharePreview
      title={user?.nickname ?? t('referralPreview.myCard')}
      subtitle="咕咕"
      qrValue={qrValue}
      initialPurpose="invite"
      zIndex={zIndex}
      onClose={onClose}
    />
  )
}

export function InviteFriendsMenuItem({ onSelect }: { onSelect: () => void }) {
  const { t } = useTranslation('main')
  if (!enabled) return null
  return (
    <MenuItem data-testid="referral-preview-menu" icon={<UserPlus size={15} />} onClick={onSelect}>
      <span className="flex items-center gap-2">{t('referralPreview.invite')}<ReferralProposalLabel /></span>
    </MenuItem>
  )
}

export function InviteFriendsPreview() {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <>
      <div className="px-4 pb-3">
        <Button
          variant="ghost"
          size="sm"
          data-testid="referral-preview-search"
          onClick={() => setOpen(true)}
        >
          <UserPlus size={15} aria-hidden />
          {t('referralPreview.inviteToGugu')}
          <ReferralProposalLabel />
        </Button>
      </div>
      {open && <ReferralSharePreview onClose={() => setOpen(false)} />}
    </>
  )
}

export function ReferralAccountPreview() {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              {t('referralPreview.code')}
              <ReferralProposalLabel />
            </span>
          }
          description={t('referralPreview.disconnected')}
          control={
            <Button
              variant="ghost"
              size="sm"
              data-testid="referral-preview-account"
              onClick={() => setOpen(true)}
            >
              {t('referralPreview.view')}
            </Button>
          }
        />
      </SettingsGroup>
      {open && <ReferralSharePreview zIndex="var(--z-settings-modal)" onClose={() => setOpen(false)} />}
    </>
  )
}

export function ReferralCodePreview({ userId }: { userId: string }) {
  if (!enabled) return null
  return <ReferralDraftField key={userId} userId={userId} />
}

function ReferralDraftField({ userId }: { userId: string }) {
  const { t } = useTranslation('main')
  const storageKey = `gugu:referral-entry-review:${userId}`
  const [initial] = useState(() => {
    try {
      return { draft: localStorage.getItem(storageKey) ?? '', failed: false }
    } catch {
      return { draft: '', failed: true }
    }
  })
  const [draft, setDraft] = useState(initial.draft)
  const [storageError, setStorageError] = useState(initial.failed)
  const change = (value: string) => {
    setDraft(value)
    try {
      if (value) localStorage.setItem(storageKey, value)
      else localStorage.removeItem(storageKey)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }
  return (
    <div className="ta-onb-field" data-testid="referral-preview-onboarding">
      <label htmlFor="referral-preview-code" className="ta-field-label flex items-center gap-2">
        {t('referralPreview.optionalCode')}
        <ReferralProposalLabel />
      </label>
      <div className="flex items-center gap-2">
        <input
          id="referral-preview-code"
          className="ta-input min-w-0 flex-1"
          value={draft}
          onChange={(event) => change(event.target.value)}
          placeholder={t('referralPreview.placeholder')}
          aria-describedby="referral-preview-draft-note"
          autoComplete="off"
        />
        {draft && (
          <Button variant="ghost" size="sm" onClick={() => change('')}>
            {t('referralPreview.clear')}
          </Button>
        )}
      </div>
      <p
        id="referral-preview-draft-note"
        className="m-0 text-left text-[length:var(--font-caption)] text-[var(--muted-fg)]"
        role={storageError ? 'alert' : undefined}
      >
        {t(storageError ? 'referralPreview.storageError' : 'referralPreview.draftNote')}
      </p>
    </div>
  )
}
