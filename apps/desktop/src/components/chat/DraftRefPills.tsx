import { useTranslation } from 'react-i18next'
import { parseGroupFileLink } from '@gugu/core/shared/ui/fileLink'
import { FileText, X } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import type { DraftRef } from '../../store/chatContext'

/**
 * App 引用 pill (owner 10-14, A): the pills a composer holds, in the row above the input with its files — a compose's
 * refs, a pasted one. Each says what the App called it (the file and where) and goes whole: ✕ takes it out, nothing
 * edits it. On send they go under the words (`withFilePills`), and the bubble draws them as the same pill.
 */
export function DraftRefPills({ refs, onRemove }: { refs: readonly DraftRef[]; onRemove: (link: string) => void }) {
  const { t } = useTranslation('messaging')
  return refs.map((ref) => {
    const version = parseGroupFileLink(ref.link)?.version
    return (
      <span
        key={ref.link}
        data-testid={AUTOMATION_TEST_IDS.composerFilePill}
        title={version === undefined ? ref.label : `${ref.label} · ${t('filePill.picked', { version })}`}
        className="inline-flex max-w-[260px] items-center gap-1 self-center rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] pl-2 text-[length:var(--font-body)] text-[var(--text-primary)]"
      >
        <FileText size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        <span className="min-w-0 truncate">{ref.label}</span>
        <IconButton size="sm" aria-label={t('composer.removeFilePill', { label: ref.label })} onClick={() => onRemove(ref.link)}>
          <X />
        </IconButton>
      </span>
    )
  })
}
