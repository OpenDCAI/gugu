import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSettingsPaneProps } from './types'
import { useContactsStore } from '../../store/contactsContext'
import { asClass, historyToggleClass } from './agentSettingsStyles'

// TODO(history-backend): replace placeholder rows with real chat session list for this agent.
// The design shows two example history rows (a group chat + a 1:1 chat) both marked "已完成".
// Wire to a future getAgentChatHistory(agentId) call when the backend exposes it.

export function AgentHistoryPane({ agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const { setAgentDesiredStatus } = useContactsStore()

  // "暂停 Agent" toggle: paused = desired_status === 'offline'
  const isPaused = agent.desired_status === 'offline'
  const [toggling, setToggling] = useState(false)

  async function handleTogglePause() {
    if (toggling) return
    setToggling(true)
    try {
      await setAgentDesiredStatus(agent.id, isPaused ? 'online' : 'offline')
    } finally {
      setToggling(false)
    }
  }

  return (
    <div>
      {/* 暂停 Agent row — design data-pane="history" */}
      <div className={asClass.historyRow}>
        <div>
          <div className={asClass.historyArl}>{t('settings.history.pause')}</div>
          <div className={asClass.historyArd}>
            {t('settings.history.pauseHint')}
          </div>
        </div>
        {/* toggle — design .tgl / .tgl.on */}
        <button
          className={historyToggleClass(isPaused)}
          onClick={handleTogglePause}
          disabled={toggling}
          aria-label={t('settings.history.pause')}
          aria-pressed={isPaused}
        />
      </div>

      {/* 历史会话 section header */}
      <div className={asClass.historyH2}>{t('settings.history.sessions')}</div>

      {/* #1228: getAgentChatHistory(agentId) 后端未建。原实现是 2 行写死 mockup 会话
          (YiHe Yang… / 已完成) = 假数据(反 fake)。→ 诚实「即将开放」空态，不冒充真会话记录。
          后端落地后接 getAgentChatHistory(agent.id) 真列表。 */}
      <div style={{ fontSize: 'var(--font-body)', color: 'var(--faint-fg)', padding: '20px 0', textAlign: 'center' }}>
        {t('settings.history.comingSoon')}
      </div>
    </div>
  )
}
