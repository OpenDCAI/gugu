import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { AgentSettingsTab } from './types'
import { resolveAgentSettingsTab } from './resolveAgentSettingsTab'
import {
  agentSettingsPaneClass,
  agentSettingsTabClass,
  asClass,
  cx,
} from './agentSettingsStyles'
import { Sheet } from '../ui/Sheet'
import { Avatar } from '../Avatar'
import { useMobileShell } from '../../hooks/useMobileShell'
import { AgentProfilePane } from './AgentProfilePane'
import { useIsAssistantAvatar } from '../../lib/avatarIdentity'
import { AgentLookPane } from './AgentLookPane'
import { AgentSharePane } from './AgentSharePane'
import { AgentTasksPane } from './AgentTasksPane'
import { AgentAiModelPane } from './AgentAiModelPane'
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
  const assistant = useIsAssistantAvatar(agent.id)
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
  const [activeTab, setActiveTab] = useState<AgentSettingsTab>(resolveAgentSettingsTab(initialTab, assistant))
  // @@@1787 手机化(owner 审核:桌面双栏塞 390px 全挤坏)——mobile 单栏状态机:nav 全宽列表 ⇄ 详情页,
  // 出口/返回=左上箭头(手机导航规范),✗ 只留桌面。
  const mobileShell = useMobileShell()
  const [mobilePane, setMobilePane] = useState<'nav' | 'detail'>(initialTab === 'profile' ? 'nav' : 'detail')

  useEffect(() => {
    if (accountStatus === 'removed') requestClose()
  }, [accountStatus, requestClose])

  function selectTab(tab: AgentSettingsTab) {
    if (tab === 'look' && !assistant) return
    setActiveTab(tab)
    if (mobileShell) setMobilePane('detail')
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

            {assistant ? <Button
              variant="ghost"
              className={cx(agentSettingsTabClass(activeTab === 'look'), 'min-h-0 justify-start leading-[inherit]')}
              style={mobileTabStyle}
              onClick={() => selectTab('look')}
              data-testid="agent-settings-tab-look"
            >
              <Palette size={16} className="gg-as-il" aria-hidden="true" />
              <PaletteFilled size={16} className="gg-as-if" aria-hidden="true" />
              {t('settings.nav.look')}
            </Button> : null}

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

              {/* AI 模型 */}
              <button
                className={agentSettingsTabClass(activeTab === 'aimodel')}
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

          </nav>

          {/* body — render active pane; mobile: 详情层全宽 */}
          <div
            className={asClass.body}
            data-active-tab={activeTab}
            style={mobileShell ? { padding: '20px 16px max(24px, env(safe-area-inset-bottom))', display: mobilePane === 'detail' ? (activeTab === 'profile' ? 'flex' : 'block') : 'none' } : undefined}
          >
            <div className={cx(agentSettingsPaneClass(activeTab === 'profile'), 'gg-as-pane-profile')}>
              <AgentProfilePane {...paneProps} />
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'look')}>
              {/* 只在这页开着时挂:里面有十几只会动的小鸟,藏着也跑是白烧 */}
              {assistant && activeTab === 'look' ? <AgentLookPane {...paneProps} /> : null}
            </div>
            <div className={agentSettingsPaneClass(activeTab === 'share-act')}>
              <AgentSharePane {...paneProps} />
            </div>

            <div className={agentSettingsPaneClass(activeTab === 'tasks')}>
              <AgentTasksPane {...paneProps} />
            </div>

            <div className={agentSettingsPaneClass(activeTab === 'aimodel')}>
              <AgentAiModelPane {...paneProps} />
            </div>

          </div>
        </div>
      </div>
    </Sheet>
  )
}
