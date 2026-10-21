import { useTranslation } from 'react-i18next'
import type { NotificationLevel } from '@gugu/core/shared/types/chat'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Button } from '../ui/Button'

const OPTIONS: Array<{ level: NotificationLevel; testId: string }> = [
  { level: 'all', testId: AUTOMATION_TEST_IDS.chatDrawerNotifyLevelAll },
  { level: 'important', testId: AUTOMATION_TEST_IDS.chatDrawerNotifyLevelImportant },
  { level: 'none', testId: AUTOMATION_TEST_IDS.chatDrawerNotifyLevelNone },
]

export function ChatNotificationLevelControl({
  value,
  busy,
  onSelect,
}: {
  value: NotificationLevel
  busy: boolean
  onSelect: (level: NotificationLevel) => void
}) {
  const { t } = useTranslation('messaging')
  return (
    <div
      role="group"
      aria-label={t('chatArea.notificationLevel.label')}
      data-testid={AUTOMATION_TEST_IDS.chatDrawerNotifyLevel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px',
        borderRadius: 'var(--radius-surface)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}
    >
      {OPTIONS.map((option) => {
        const active = option.level === value
        return (
          <Button
            key={option.level}
            variant="ghost"
            size="sm"
            className="min-h-0"
            data-testid={option.testId}
            aria-pressed={active}
            disabled={busy}
            onClick={() => onSelect(option.level)}
            style={{
              border: 'none',
              borderRadius: 'var(--radius-control)',
              padding: '6px 10px',
              fontSize: 'var(--font-body)',
              cursor: busy ? 'default' : 'pointer',
              // @@@live-accent (Refs #6105) 「currently selected」是 live 态,归唯一 accent(--live);--accent 是品牌色不表达状态。
              background: active ? 'var(--live-soft)' : 'transparent',
              color: active ? 'var(--live)' : 'var(--text-secondary)',
              opacity: busy ? 0.65 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {option.level === 'all'
              ? t('chatArea.notificationLevel.all')
              : option.level === 'important'
                ? t('chatArea.notificationLevel.important')
                : t('chatArea.notificationLevel.none')}
          </Button>
        )
      })}
    </div>
  )
}
