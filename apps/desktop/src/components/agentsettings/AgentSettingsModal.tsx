import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { AgentSettingsTab } from './types'
import {
  agentSettingsPaneClass,
  agentSettingsSubTabClass,
  agentSettingsSubsClass,
  agentSettingsTabClass,
  asClass,
  cx,
} from './agentSettingsStyles'
import { Sheet } from '../ui/Sheet'
import { Avatar } from '../Avatar'
import { useMobileShell } from '../../hooks/useMobileShell'
import { AgentProfilePane } from './AgentProfilePane'
import { AgentLookPane } from './AgentLookPane'
import { AgentSharePane } from './AgentSharePane'
import { AgentHistoryPane } from './AgentHistoryPane'
import { AgentContactsPane } from './AgentContactsPane'
import { AgentTasksPane } from './AgentTasksPane'
import { AgentFinancePane } from './AgentFinancePane'
import { AgentAiModelPane } from './AgentAiModelPane'
import { AgentMemoryPane } from './AgentMemoryPane'
import { AgentPermissionsPane } from './AgentPermissionsPane'
import { AgentSecretsPane } from './AgentSecretsPane'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import { useAgentHeaderStatusText } from '../../hooks/useAgentHeaderStatusText'
import { useShownAgentStatus } from '../chat/useAgentsOnCloudComputer'
import { useContactsStore } from '../../store/contactsContext'
import { Palette, PaletteFilled } from '@/lib/icons'
import { Button } from '../ui/Button'

export interface AgentSettingsModalProps {
  agent: ContactUser
  onClose?: () => void
  /** 打开时停在哪一页(「助理」App 里点头像换形象 = 'look')。 */
  initialTab?: AgentSettingsTab
}

export function AgentSettingsModal({ agent: openedAgent, onClose, initialTab = 'profile' }: AgentSettingsModalProps) {
  const { t } = useTranslation('agents')
  // 打开时拿到的是一份快照(通讯录把选中的人存在自己的 state 里);资料 / 形象一保存,头部头像与各页要看到新的那份 ——
  // 通讯录里有这个人就读通讯录里最新的。
  const { contacts } = useContactsStore()
  const agent = contacts.find((contact) => contact.id === openedAgent.id) ?? openedAgent
  const { presence, status: displayStatus } = useAgentDisplayStatus(agent.id)
  const headerStatus = useAgentHeaderStatusText(agent.id)
  const shownStatus = useShownAgentStatus().status(agent.id, displayStatus) // #7199 宿主闲时收回着 ≠ 不在线
  const headerOffline = shownStatus === 'offline' || shownStatus === 'removed'
  const accountStatus = presence.payload?.accountStatus ?? null
  const closeRequestedRef = useRef(false)
  const requestClose = useCallback(() => {
    if (closeRequestedRef.current) return
    closeRequestedRef.current = true
    onClose?.()
  }, [onClose])
  const [activeTab, setActiveTab] = useState<AgentSettingsTab>(initialTab)
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  // @@@1787 手机化(owner 审核:桌面双栏塞 390px 全挤坏)——mobile 单栏状态机:nav 全宽列表 ⇄ 详情页,
  // 出口/返回=左上箭头(手机导航规范),✗ 只留桌面。
  const mobileShell = useMobileShell()
  const [mobilePane, setMobilePane] = useState<'nav' | 'detail'>('nav')

  useEffect(() => {
    if (accountStatus === 'removed') requestClose()
  }, [accountStatus, requestClose])

  const settingsSubTabs: AgentSettingsTab[] = ['aimodel', 'memory', 'permissions', 'secrets']
  const isSettingsTab = settingsSubTabs.includes(activeTab)

  function selectTab(tab: AgentSettingsTab) {
    if (settingsSubTabs.includes(tab) && !settingsExpanded) {
      setSettingsExpanded(true)
    }
    setActiveTab(tab)
    if (mobileShell) setMobilePane('detail')
  }

  function toggleSettings() {
    setSettingsExpanded(prev => !prev)
    if (!settingsExpanded && !isSettingsTab) {
      setActiveTab('aimodel')
    }
  }

  const paneProps = { agent, onClose: requestClose, onOpenTab: selectTab }
  // @@@1787 mobile rail 行触控放大(全宽列表行 46px)。桌面 tabBase 是 13,移动这一档必须比它大:
  // 归到 13 等于把放大整个抹掉,还会掉到移动端正文 >=14px 线下;字阶没有 14,所以上到 15。
  const mobileTabStyle = mobileShell ? { minHeight: 46, fontSize: 'var(--font-title)' } : undefined

  if (accountStatus !== 'active') return null

  return (
    <Sheet
      fullScreenMobile
      desktopWidth="880px"
      desktopMaxHeight="580px" desktopHeight="580px"
      onClose={requestClose}
      // 返回键 / Esc 与左上箭头同一件事:详情层先回 nav 层,❌ 整个设置一起关掉。
      onEscape={() => {
        if (mobilePane !== 'detail') return false
        setMobilePane('nav')
        return true
      }}
      testId="agent-settings-modal"
      ariaLabel={t('settings.ariaLabel')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* top bar */}
        <div className={asClass.top} style={mobileShell ? { padding: '12px 14px' } : undefined}>
          {/* @@@1787 手机导航规范:左上返回箭头——nav 层=关闭,详情层=回 nav */}
          {mobileShell ? (
            <button
              type="button"
              className="gg-pressable"
              aria-label={mobilePane === 'detail' ? t('settings.back') : t('settings.close')}
              onClick={() => (mobilePane === 'detail' ? setMobilePane('nav') : requestClose())}
              style={{
                width: 38,
                height: 38,
                border: 'none',
                borderRadius: 'var(--radius-xl)',
                background: 'transparent',
                color: 'var(--muted-fg)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
                marginLeft: -8,
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 5l-7 7l7 7"/></svg>
            </button>
          ) : null}
          {/* #1461 收尾(reopen 漏的第 6 处 surface)：标题栏头像统一走 Avatar，只保留 canonical URL；缺失时明确空态。 */}
          <div className={asClass.topAvatar} style={{ flexShrink: 0 }}>
            <Avatar
              name={agent.display_name}
              avatarUrl={agent.avatar}
              seed={agent.id}
              size="sm"
              isAgent={agent.type === 'agent'}
            />
          </div>
          <div className={asClass.titleBlock}>
            <span className={asClass.name}>{agent.display_name}</span>
            {/* 与聊天标题栏同一句「状态 · 在哪台机器 · 引擎」(❌ 写死的「外部 · 本机」「在线 · Local ACP」)。 */}
            <span className={asClass.status} data-testid="agent-settings-header-status" data-offline={headerOffline || undefined}>{headerStatus}</span>
          </div>
          {!mobileShell ? (
          <button className={asClass.close} onClick={requestClose} aria-label={t('settings.close')}>
            {/* close X circle */}
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24">
              <g fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/>
                <path strokeLinecap="round" d="m14.5 9.5l-5 5m0-5l5 5"/>
              </g>
            </svg>
          </button>
          ) : null}
        </div>

        {/* main */}
        <div className={asClass.main}>
          {/* rail — mobile: 全宽单栏列表(nav 层),选中即进详情 */}
          <nav
            className={asClass.rail}
            style={mobileShell ? { width: '100%', borderRight: 'none', padding: '8px 14px', display: mobilePane === 'nav' ? 'flex' : 'none' } : undefined}
          >
            {/* 资料 */}
            <button
              className={agentSettingsTabClass(activeTab === 'profile')}
              style={mobileTabStyle}
              onClick={() => selectTab('profile')}
            >
              {/* profile linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="6" r="4"/>
                  <ellipse cx="12" cy="17" rx="7" ry="4"/>
                </g>
              </svg>
              {/* profile filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <circle cx="12" cy="6" r="4" fill="currentColor"/>
                <ellipse cx="12" cy="17" fill="currentColor" rx="7" ry="4"/>
              </svg>
              {t('settings.nav.profile')}
            </button>

            {/* 形象 —— 给 agent 捏个样子(身体颜色 + 休息表情) */}
            <Button
              variant="ghost"
              className={cx(agentSettingsTabClass(activeTab === 'look'), 'min-h-0 justify-start leading-[inherit]')}
              style={mobileTabStyle}
              onClick={() => selectTab('look')}
              data-testid="agent-settings-tab-look"
            >
              <Palette size={16} className="gg-as-il" aria-hidden="true" />
              <PaletteFilled size={16} className="gg-as-if" aria-hidden="true" />
              {t('settings.nav.look')}
            </Button>

            {/* 分享 */}
            <button
              className={agentSettingsTabClass(activeTab === 'share-act')}
              style={mobileTabStyle}
              onClick={() => selectTab('share-act')}
            >
              {/* share linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
                  <path d="M4 12a8 8 0 1 0 16 0"/>
                  <path strokeLinejoin="round" d="M12 14V4m0 0l3 3m-3-3L9 7"/>
                </g>
              </svg>
              {/* share filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" fillRule="evenodd" d="M8.845 7.905a.75.75 0 0 0 1.06 0l1.72-1.72v8.19a.75.75 0 0 0 1.5 0v-8.19l1.72 1.72a.75.75 0 1 0 1.06-1.06l-3-3a.75.75 0 0 0-1.06 0l-3 3a.75.75 0 0 0 0 1.06" clipRule="evenodd"/>
                <path fill="currentColor" d="M12.375 20.375a8 8 0 0 0 8-8h-3.75c-.943 0-1.414 0-1.707.293s-.293.764-.293 1.707a2.25 2.25 0 0 1-4.5 0c0-.943 0-1.414-.293-1.707s-.764-.293-1.707-.293h-3.75a8 8 0 0 0 8 8"/>
              </svg>
              {t('settings.nav.share')}
            </button>

            {/* 聊天记录 */}
            <button
              className={agentSettingsTabClass(activeTab === 'history')}
              style={mobileTabStyle}
              onClick={() => selectTab('history')}
            >
              {/* history linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z"/>
              </svg>
              {/* history filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22"/>
              </svg>
              {t('settings.nav.history')}
            </button>

            {/* 通讯录 */}
            <button
              className={agentSettingsTabClass(activeTab === 'contacts')}
              style={mobileTabStyle}
              onClick={() => selectTab('contacts')}
            >
              {/* contacts linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 10c0-3.771 0-5.657 1.172-6.828S7.229 2 11 2h2c3.771 0 5.657 0 6.828 1.172S21 6.229 21 10v4c0 3.771 0 5.657-1.172 6.828S16.771 22 13 22h-2c-3.771 0-5.657 0-6.828-1.172S3 17.771 3 14z"/>
                  <path strokeLinecap="round" d="M8 12h8M8 8h8m-8 8h5"/>
                </g>
              </svg>
              {/* contacts filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" fillRule="evenodd" d="M4.172 3.172C3 4.343 3 6.229 3 10v4c0 3.771 0 5.657 1.172 6.828S7.229 22 11 22h2c3.771 0 5.657 0 6.828-1.172S21 17.771 21 14v-4c0-3.771 0-5.657-1.172-6.828S16.771 2 13 2h-2C7.229 2 5.343 2 4.172 3.172M7.25 8A.75.75 0 0 1 8 7.25h8a.75.75 0 0 1 0 1.5H8A.75.75 0 0 1 7.25 8m0 4a.75.75 0 0 1 .75-.75h8a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1-.75-.75M8 15.25a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5z" clipRule="evenodd"/>
              </svg>
              {t('settings.nav.contacts')}
            </button>

            {/* 定时任务 */}
            <button
              className={agentSettingsTabClass(activeTab === 'tasks')}
              style={mobileTabStyle}
              onClick={() => selectTab('tasks')}
            >
              {/* tasks linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 12c0-4.714 0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22s-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12Z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12.5l2 2l5-5"/>
                </g>
              </svg>
              {/* tasks filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" fillRule="evenodd" d="M12 22c-4.714 0-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12s0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22m4.03-13.03a.75.75 0 0 1 0 1.06l-5 5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06l1.47 1.47l4.47-4.47a.75.75 0 0 1 1.06 0" clipRule="evenodd"/>
              </svg>
              {t('settings.nav.tasks')}
            </button>

            {/* 账务 */}
            <button
              className={agentSettingsTabClass(activeTab === 'finance')}
              style={mobileTabStyle}
              onClick={() => selectTab('finance')}
            >
              {/* finance linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 12c0-3.771 0-5.657 1.172-6.828S6.229 4 10 4h4c3.771 0 5.657 0 6.828 1.172S22 8.229 22 12s0 5.657-1.172 6.828S17.771 20 14 20h-4c-3.771 0-5.657 0-6.828-1.172S2 15.771 2 12Z"/>
                  <path strokeLinecap="round" d="M10 16.5H6m2-3H6M2 10h20"/>
                  <path d="M14 15c0-.943 0-1.414.293-1.707S15.057 13 16 13s1.414 0 1.707.293S18 14.057 18 15s0 1.414-.293 1.707S16.943 17 16 17s-1.414 0-1.707-.293S14 15.943 14 15Z"/>
                </g>
              </svg>
              {/* finance filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" d="M14 4h-4C6.229 4 4.343 4 3.172 5.172c-.844.843-1.08 2.057-1.146 4.078h19.948c-.066-2.021-.302-3.235-1.146-4.078C19.657 4 17.771 4 14 4"/>
                <path fill="currentColor" fillRule="evenodd" d="M14 20h-4c-3.771 0-5.657 0-6.828-1.172S2 15.771 2 12q0-.662.002-1.25h19.996Q22 11.338 22 12c0 3.771 0 5.657-1.172 6.828S17.771 20 14 20m2.045-7.75c.433 0 .83 0 1.152.043c.356.048.731.16 1.04.47s.422.684.47 1.04c.043.323.043.72.043 1.152v.09c0 .433 0 .83-.043 1.152c-.048.356-.16.731-.47 1.04s-.684.422-1.04.47c-.323.043-.72.043-1.152.043h-.09c-.433 0-.83 0-1.152-.043c-.356-.048-.731-.16-1.04-.47s-.422-.684-.47-1.04c-.043-.323-.043-.72-.043-1.152v-.09c0-.433 0-.83.043-1.152c.048-.356.16-.731.47-1.04s.684-.422 1.04-.47c.323-.043.72-.043 1.152-.043zM5.25 13.5a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5H6a.75.75 0 0 1-.75-.75m0 3a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H6a.75.75 0 0 1-.75-.75" clipRule="evenodd"/>
                <path fill="currentColor" d="m14.823 13.823l.003-.001l.01-.005a.7.7 0 0 1 .167-.037c.21-.028.504-.03.997-.03s.787.002.997.03a.7.7 0 0 1 .177.042l.003.001l.001.003l.005.01c.009.022.024.07.037.167c.028.21.03.504.03.997s-.002.787-.03.997a.7.7 0 0 1-.042.177l-.001.003l-.003.001l-.01.005a.7.7 0 0 1-.167.037c-.21.028-.504.03-.997.03s-.787-.002-.997-.03a.7.7 0 0 1-.177-.042l-.003-.001l-.001-.003l-.005-.01a.7.7 0 0 1-.037-.167c-.028-.21-.03-.504-.03-.997s.002-.787.03-.997a.7.7 0 0 1 .042-.177z"/>
              </svg>
              {t('settings.nav.finance')}
            </button>

            {/* 设置 accordion toggle */}
            <button
              className={cx(
                agentSettingsTabClass(isSettingsTab, asClass.settingsToggle),
                settingsExpanded && asClass.settingsToggleExpanded,
              )}
              style={mobileTabStyle}
              onClick={toggleSettings}
            >
              {/* settings linear */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-il">
                <g fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M13.765 2.152C13.398 2 12.932 2 12 2s-1.398 0-1.765.152a2 2 0 0 0-1.083 1.083c-.092.223-.129.484-.143.863a1.62 1.62 0 0 1-.79 1.353a1.62 1.62 0 0 1-1.567.008c-.336-.178-.579-.276-.82-.308a2 2 0 0 0-1.478.396C4.04 5.79 3.806 6.193 3.34 7s-.7 1.21-.751 1.605a2 2 0 0 0 .396 1.479c.148.192.355.353.676.555c.473.297.777.803.777 1.361s-.304 1.064-.777 1.36c-.321.203-.529.364-.676.556a2 2 0 0 0-.396 1.479c.052.394.285.798.75 1.605c.467.807.7 1.21 1.015 1.453a2 2 0 0 0 1.479.396c.24-.032.483-.13.819-.308a1.62 1.62 0 0 1 1.567.008c.483.28.77.795.79 1.353c.014.38.05.64.143.863a2 2 0 0 0 1.083 1.083C10.602 22 11.068 22 12 22s1.398 0 1.765-.152a2 2 0 0 0 1.083-1.083c.092-.223.129-.483.143-.863c.02-.558.307-1.074.79-1.353a1.62 1.62 0 0 1 1.567-.008c.336.178.579.276.819.308a2 2 0 0 0 1.479-.396c.315-.242.548-.646 1.014-1.453s.7-1.21.751-1.605a2 2 0 0 0-.396-1.479c-.148-.192-.355-.353-.676-.555A1.62 1.62 0 0 1 19.562 12c0-.558.304-1.064.777-1.36c.321-.203.529-.364.676-.556a2 2 0 0 0 .396-1.479c-.052-.394-.285-.798-.75-1.605c-.467-.807-.7-1.21-1.015-1.453a2 2 0 0 0-1.479-.396c-.24.032-.483.13-.82.308a1.62 1.62 0 0 1-1.566-.008a1.62 1.62 0 0 1-.79-1.353c-.014-.38-.05-.64-.143-.863a2 2 0 0 0-1.083-1.083Z"/>
                </g>
              </svg>
              {/* settings filled */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" className="gg-as-if">
                <path fill="currentColor" fillRule="evenodd" d="M14.279 2.152C13.909 2 13.439 2 12.5 2s-1.408 0-1.779.152a2 2 0 0 0-1.09 1.083c-.094.223-.13.484-.145.863a1.62 1.62 0 0 1-.796 1.353a1.64 1.64 0 0 1-1.579.008c-.338-.178-.583-.276-.825-.308a2.03 2.03 0 0 0-1.49.396c-.318.242-.553.646-1.022 1.453c-.47.807-.704 1.21-.757 1.605c-.07.526.074 1.058.4 1.479c.148.192.357.353.68.555c.477.297.783.803.783 1.361s-.306 1.064-.782 1.36c-.324.203-.533.364-.682.556a2 2 0 0 0-.399 1.479c.053.394.287.798.757 1.605s.704 1.21 1.022 1.453c.424.323.96.465 1.49.396c.242-.032.487-.13.825-.308a1.64 1.64 0 0 1 1.58.008c.486.28.774.795.795 1.353c.015.38.051.64.145.863c.204.49.596.88 1.09 1.083c.37.152.84.152 1.779.152s1.409 0 1.779-.152a2 2 0 0 0 1.09-1.083c.094-.223.13-.483.145-.863c.02-.558.309-1.074.796-1.353a1.64 1.64 0 0 1 1.579-.008c.338.178.583.276.825.308c.53.07 1.066-.073 1.49-.396c.318-.242.553-.646 1.022-1.453c.47-.807.704-1.21.757-1.605a2 2 0 0 0-.4-1.479c-.148-.192-.357-.353-.68-.555c-.477-.297-.783-.803-.783-1.361s.306-1.064.782-1.36c.324-.203.533-.364.682-.556a2 2 0 0 0 .399-1.479c-.053-.394-.287-.798-.757-1.605s-.704-1.21-1.022-1.453a2.03 2.03 0 0 0-1.49-.396c-.242.032-.487.13-.825.308a1.64 1.64 0 0 1-1.58-.008a1.62 1.62 0 0 1-.795-1.353c-.015-.38-.051-.64-.145-.863a2 2 0 0 0-1.09-1.083M12.5 15c1.67 0 3.023-1.343 3.023-3S14.169 9 12.5 9s-3.023 1.343-3.023 3s1.354 3 3.023 3" clipRule="evenodd"/>
              </svg>
              {t('settings.nav.settings')}
              {/* chevron */}
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" className="gg-as-tab-chev">
                <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="m19 9l-7 6l-7-6"/>
              </svg>
            </button>

            {/* settings sub-tabs accordion */}
            <div className={agentSettingsSubsClass(settingsExpanded)}>
              {/* AI 模型 */}
              <button
                className={agentSettingsSubTabClass(activeTab === 'aimodel')}
                style={mobileTabStyle}
                onClick={() => selectTab('aimodel')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-il">
                  <g fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M7 10c0-1.414 0-2.121.44-2.56C7.878 7 8.585 7 10 7h4c1.414 0 2.121 0 2.56.44c.44.439.44 1.146.44 2.56v4c0 1.414 0 2.121-.44 2.56c-.439.44-1.146.44-2.56.44h-4c-1.414 0-2.121 0-2.56-.44C7 16.122 7 15.415 7 14z"/>
                    <path d="M4 12c0-3.771 0-5.657 1.172-6.828S8.229 4 12 4s5.657 0 6.828 1.172S20 8.229 20 12s0 5.657-1.172 6.828S15.771 20 12 20s-5.657 0-6.828-1.172S4 15.771 4 12Z"/>
                    <path strokeLinecap="round" d="M4 12H2m20 0h-2M4 9H2m20 0h-2M4 15H2m20 0h-2m-8 5v2m0-20v2M9 20v2M9 2v2m6 16v2m0-20v2"/>
                  </g>
                </svg>
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-if">
                  <path fill="currentColor" d="M9.181 10.181c.053-.053.148-.119.45-.16c.323-.043.761-.044 1.439-.044h1.86c.678 0 1.116.001 1.438.045c.303.04.398.106.45.16c.054.052.12.147.16.45c.044.322.045.76.045 1.438v1.86c0 .678-.001 1.116-.045 1.438c-.04.303-.106.398-.16.45c-.052.054-.147.12-.45.16c-.322.044-.76.045-1.438.045h-1.86c-.678 0-1.116-.001-1.438-.045c-.303-.04-.398-.106-.45-.16c-.054-.052-.12-.147-.16-.45c-.044-.322-.045-.76-.045-1.438v-1.86c0-.678.001-1.116.045-1.438c.04-.303.106-.398.16-.45"/>
                  <path fill="currentColor" fillRule="evenodd" d="M12 3c.385 0 .698.312.698.698v2.79q.764.001 1.395.017V3.698a.698.698 0 0 1 1.395 0v2.79a1 1 0 0 1-.008.108c.936.115 1.585.353 2.078.846s.731 1.142.846 2.078a1 1 0 0 1 .108-.008h2.79a.698.698 0 0 1 0 1.395h-2.807q.017.63.017 1.395h2.79a.698.698 0 0 1 0 1.396h-2.79q-.001.764-.017 1.395h2.807a.698.698 0 0 1 0 1.395h-2.79a1 1 0 0 1-.108-.008c-.115.936-.353 1.585-.846 2.078s-1.142.731-2.078.846q.009.053.008.108v2.79a.698.698 0 0 1-1.395 0v-2.807q-.63.017-1.395.017v2.79a.698.698 0 0 1-1.396 0v-2.79a56 56 0 0 1-1.395-.017v2.807a.698.698 0 0 1-1.395 0v-2.79q0-.056.008-.108c-.936-.115-1.585-.353-2.078-.846s-.731-1.142-.846-2.078a1 1 0 0 1-.108.008h-2.79a.698.698 0 0 1 0-1.395h2.807a56 56 0 0 1-.017-1.395h-2.79a.698.698 0 0 1 0-1.396h2.79q.001-.764.017-1.395H2.698a.698.698 0 0 1 0-1.395h2.79q.056 0 .108.008c.115-.936.353-1.585.846-2.078s1.142-.731 2.078-.846a1 1 0 0 1-.008-.108v-2.79a.698.698 0 0 1 1.395 0v2.807q.63-.017 1.395-.017v-2.79c0-.386.313-.698.698-.698m-.976 5.581c-.619 0-1.152 0-1.578.058c-.458.061-.896.2-1.252.555c-.355.356-.494.794-.555 1.252c-.058.427-.058.96-.058 1.578v1.952c0 .619 0 1.151.058 1.578c.061.458.2.896.555 1.252c.356.355.794.494 1.252.555c.426.058.96.058 1.578.058h1.952c.619 0 1.151 0 1.578-.058c.458-.061.896-.2 1.252-.555c.355-.356.494-.794.555-1.252c.058-.427.058-.96.058-1.578v-1.952c0-.619 0-1.151-.058-1.578c-.061-.458-.2-.896-.555-1.252c-.356-.355-.794-.494-1.252-.555c-.427-.058-.96-.058-1.578-.058z" clipRule="evenodd"/>
                </svg>
                {t('settings.nav.aiModel')}
              </button>

              {/* 记忆 */}
              <button
                className={agentSettingsSubTabClass(activeTab === 'memory')}
                style={mobileTabStyle}
                onClick={() => selectTab('memory')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-il">
                  <g fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14.5 19.5h-5m5 0c0-.713 0-1.07.038-1.307c.123-.763.144-.812.631-1.412c.151-.186.711-.688 1.832-1.692A7.5 7.5 0 1 0 7 15.09c1.12 1.004 1.68 1.505 1.832 1.692c.487.6.508.649.63 1.412c.039.237.039.593.039 1.307m5 0c0 .935 0 1.402-.201 1.75a1.5 1.5 0 0 1-.549.549c-.349.2-.816.2-1.751.2s-1.402 0-1.75-.201a1.5 1.5 0 0 1-.549-.549c-.201-.348-.201-.815-.201-1.75"/>
                    <path strokeLinecap="round" d="M12 17v-2m1.732-1a2 2 0 0 1-3.464 0"/>
                  </g>
                </svg>
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-if">
                  <defs>
                    <mask id="gg-as-memory-mask">
                      <g fill="none" fillRule="evenodd" clipRule="evenodd">
                        <path fill="#fff" d="M11.5 2C7.358 2 4 5.436 4 9.674c0 2.273.966 4.315 2.499 5.72c.51.467.889.814 1.157 1.066a15 15 0 0 1 .4.39l.033.036c.237.3.288.376.318.446s.053.16.112.54c.024.15.026.406.026 1.105v.03c0 .409 0 .762.026 1.051c.027.306.087.61.248.895c.18.319.438.583.75.767c.278.165.575.226.874.254c.283.026.628.026 1.028.026h.058c.4 0 .745 0 1.028-.026c.3-.028.595-.09.875-.254a2.07 2.07 0 0 0 .749-.767c.16-.285.22-.588.248-.895c.026-.29.026-.642.025-1.051v-.03c0-.699.003-.955.026-1.105c.06-.38.082-.47.113-.54c.03-.07.081-.147.318-.446l.003-.003l.005-.006l.025-.027l.088-.09q.112-.113.312-.3c.268-.252.647-.599 1.157-1.067A7.74 7.74 0 0 0 19 9.674C19 5.436 15.642 2 11.5 2m1.57 17.932q.011-.113.015-.258h-3.17q.004.145.014.258c.019.21.05.286.071.324a.7.7 0 0 0 .25.255c.037.022.111.054.316.073c.214.02.497.02.934.02s.72 0 .934-.02c.205-.019.279-.05.316-.073a.7.7 0 0 0 .25-.255c.021-.038.052-.114.07-.324"/>
                        <path fill="#000" d="M9.274 13.35a.75.75 0 0 1 1.025.274a1.25 1.25 0 0 0 2.166 0a.75.75 0 1 1 1.298.752a2.76 2.76 0 0 1-1.631 1.27V17a.75.75 0 0 1-1.5 0v-1.354A2.76 2.76 0 0 1 9 14.376a.75.75 0 0 1 .274-1.025"/>
                      </g>
                    </mask>
                  </defs>
                  <path fill="currentColor" d="M0 0h24v24H0z" mask="url(#gg-as-memory-mask)"/>
                </svg>
                {t('settings.nav.memory')}
              </button>

              {/* 权限 */}
              <button
                className={agentSettingsSubTabClass(activeTab === 'permissions')}
                style={mobileTabStyle}
                onClick={() => selectTab('permissions')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-il">
                  <g fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 10.417c0-3.198 0-4.797.378-5.335c.377-.537 1.88-1.052 4.887-2.081l.573-.196C10.405 2.268 11.188 2 12 2s1.595.268 3.162.805l.573.196c3.007 1.029 4.51 1.544 4.887 2.081C21 5.62 21 7.22 21 10.417v1.574c0 5.638-4.239 8.375-6.899 9.536C13.38 21.842 13.02 22 12 22s-1.38-.158-2.101-.473C7.239 20.365 3 17.63 3 11.991z"/>
                    <path d="m3 11l9-3l9 3m-9-9v19.5"/>
                  </g>
                </svg>
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-if">
                  <path fill="currentColor" d="M11.25 2.073c-.606.113-1.318.357-2.412.732L8.265 3c-3.007 1.03-4.51 1.544-4.887 2.082C3.008 5.608 3 7.15 3 10.21l8.25-2.75zm0 6.967L3 11.79v.201c0 5.638 4.239 8.374 6.899 9.536c.51.223.84.367 1.351.432zm1.5 12.92V9.04L21 11.79v.201c0 5.638-4.239 8.374-6.899 9.536c-.51.223-.84.367-1.351.432m0-14.499V2.072c.606.113 1.318.357 2.412.732l.573.196c3.007 1.029 4.51 1.543 4.887 2.081c.37.526.378 2.068.378 5.127z"/>
                </svg>
                {t('settings.nav.permissions')}
              </button>

              {/* 密钥 */}
              <button
                className={agentSettingsSubTabClass(activeTab === 'secrets')}
                style={mobileTabStyle}
                onClick={() => selectTab('secrets')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-il">
                  <g fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinejoin="round" d="M15.68 14.587c3.49 0 6.32-2.818 6.32-6.294S19.17 2 15.68 2S9.363 4.818 9.363 8.293c0 1.61.734 2.781.734 2.781l-7.642 7.61c-.343.342-.823 1.23 0 2.05l.882.878c.343.293 1.205.703 1.91 0l1.03-1.024c1.028 1.024 2.204.439 2.645-.147c.734-1.024-.147-2.049-.147-2.049l.294-.293c1.41 1.406 2.645.586 3.086 0c.735-1.024 0-2.049 0-2.049c-.294-.585-.882-.585-.147-1.317l.882-.878c.705.585 2.155.732 2.792.732Z"/>
                    <path d="M17.885 8.294a2.2 2.2 0 0 1-2.204 2.195a2.2 2.2 0 0 1-2.204-2.195a2.2 2.2 0 0 1 2.204-2.196a2.2 2.2 0 0 1 2.204 2.196Z"/>
                  </g>
                </svg>
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" className="gg-as-if">
                  <path fill="currentColor" fillRule="evenodd" d="M22 8.293c0 3.476-2.83 6.294-6.32 6.294c-.636 0-2.086-.146-2.791-.732l-.882.878c-.519.517-.379.669-.148.919c.096.105.208.226.295.399c0 0 .735 1.024 0 2.049c-.441.585-1.676 1.404-3.086 0l-.294.292s.881 1.025.147 2.05c-.441.585-1.617 1.17-2.646.146l-1.028 1.024c-.706.703-1.568.293-1.91 0l-.883-.878c-.823-.82-.343-1.708 0-2.05l7.642-7.61s-.735-1.17-.735-2.78c0-3.476 2.83-6.294 6.32-6.294S22 4.818 22 8.293m-6.319 2.196a2.2 2.2 0 0 0 2.204-2.195a2.2 2.2 0 0 0-2.204-2.196a2.2 2.2 0 0 0-2.204 2.196a2.2 2.2 0 0 0 2.204 2.195" clipRule="evenodd"/>
                </svg>
                {t('settings.nav.secrets')}
              </button>
            </div>
          </nav>

          {/* body — render active pane; mobile: 详情层全宽 */}
          <div
            className={asClass.body}
            style={mobileShell ? { padding: '20px 16px max(24px, env(safe-area-inset-bottom))', display: mobilePane === 'detail' ? 'block' : 'none' } : undefined}
          >
            <div className={agentSettingsPaneClass(activeTab === 'profile')}>
              <AgentProfilePane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'look')}>
              {/* 只在这页开着时挂:里面有十几只会动的小鸟,藏着也跑是白烧 */}
              {activeTab === 'look' ? <AgentLookPane {...paneProps} /> : null}
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'share-act')}>
              <AgentSharePane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'history')}>
              <AgentHistoryPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'contacts')}>
              <AgentContactsPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'tasks')}>
              <AgentTasksPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'finance')}>
              <AgentFinancePane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'aimodel')}>
              <AgentAiModelPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'memory')}>
              <AgentMemoryPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'permissions')}>
              <AgentPermissionsPane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'secrets')}>
              <AgentSecretsPane {...paneProps} />
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
