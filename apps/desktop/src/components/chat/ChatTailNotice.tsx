import { useTranslation } from 'react-i18next'
import type { HistoryWindow } from '@/store/chatHistoryWindow'
import { COLOR_ACCENT, COLOR_ON_ACCENT } from './chatPresentation'

/** The existing new-message/return-latest control, backed by the shared tail policy. */
export function ChatTailNotice({ window, hidden, onClick }: { window?: HistoryWindow; hidden: boolean; onClick: () => void }) {
  const { t } = useTranslation('messaging')
  if (hidden || !((window?.newMessageCount ?? 0) > 0 || window?.hasNewer)) return null
  return (
        <div
          onClick={onClick}
          style={{
            position: 'absolute',
            bottom: '180px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: COLOR_ACCENT,
            color: COLOR_ON_ACCENT,
            padding: '4px 14px',
            borderRadius: 'var(--radius-xl)',
            fontSize: 'var(--font-caption)',
            cursor: 'pointer',
            zIndex: 'var(--z-float)',
            boxShadow: 'var(--shadow-lift)', // @@@shadow-lift (Refs #6105) 真浮层,走唯一那一档(--shadow-card 已随阴影清零删掉)
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          {(window?.newMessageCount ?? 0) > 0 ? t('chatArea.newMessages', { count: window!.newMessageCount }) : t('chatArea.returnToLatest')}
        </div>
  )
}
