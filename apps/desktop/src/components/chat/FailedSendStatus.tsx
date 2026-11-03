import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/** Shared failed-message disclosure, including the existing touch menu. */
export function FailedSendStatus({ reason, label, onRetry, onDiscard, onEdit }: {
  reason?: string | null; label?: string; onRetry?: () => void; onDiscard: () => void; onEdit?: () => void
}) {
  const { t } = useTranslation('messaging')
  const [open, setOpen] = useState(false)
  const failureReason = safeFailureLine(reason ?? '')
  const run = (action: () => void) => { setOpen(false); action() }
  return <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenu.Trigger type="button" data-testid="message-send-failed" aria-label={t('message.sendStatus.failedHint')}
      title={failureReason || undefined} className="gg-pressable"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', cursor: 'pointer',
        background: 'transparent', padding: '1px 4px', borderRadius: 'var(--radius-control)', flexShrink: 0,
        color: 'var(--danger-fg)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', whiteSpace: 'nowrap', maxWidth: '100%' }}>
      <svg width="13" height="13" viewBox="0 0 15 15" fill="none" style={{ display: 'block', flexShrink: 0 }}>
        <circle cx="7.5" cy="7.5" r="6" stroke="var(--danger)" strokeWidth="1.5" />
        <path d="M7.5 4.2v3.6" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="7.5" cy="10.8" r=".8" fill="var(--danger)" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label ?? t('message.sendStatus.failed')}</span>
    </DropdownMenu.Trigger>
    {open && <DropdownMenu.Content data-testid="message-send-failed-menu" aria-label={t('message.sendStatus.failedActions')}
      side="top" align="end" sideOffset={4} style={{ minWidth: 96 }}>
      {failureReason && <div className="max-w-72 break-words px-3 py-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">{failureReason}</div>}
      {onRetry && <MenuItem render={<button type="button" />} nativeButton data-testid="message-send-retry"
        onClick={() => run(onRetry)} style={{ minHeight: 32, fontSize: 'var(--font-body)' }}>{t('common.retry')}</MenuItem>}
      {onEdit && <MenuItem render={<button type="button" />} nativeButton data-testid="message-send-edit"
        onClick={() => run(onEdit)} style={{ minHeight: 32, fontSize: 'var(--font-body)' }}>{translateSessionMessage('transcript.editMessage')}</MenuItem>}
      <MenuItem render={<button type="button" />} nativeButton data-testid="message-send-discard" danger
        onClick={() => run(onDiscard)} style={{ minHeight: 32, fontSize: 'var(--font-body)' }}>{t('common.discard')}</MenuItem>
    </DropdownMenu.Content>}
  </DropdownMenu.Root>
}
