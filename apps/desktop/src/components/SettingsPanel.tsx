import { useState } from 'react'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { useAuth } from '../store/auth'
import { useContactsStore } from '../store/contactsContext'
import { useDevicesStore } from '../store/devicesContext'
import { useMyAssistantContact } from '../lib/myAssistant'
import { AboutSection } from './settings/AboutSection'
import { AccountSection } from './settings/AccountSection'
import { AssistantSection, type AssistantPageTab } from './settings/AssistantSection'
import { ConnectorsSection } from './settings/ConnectorsSection'
import { SettingsNote } from './settings/SettingsPrimitives'
import { DevicesSection } from './settings/DevicesSection'
import { GeneralSection } from './settings/GeneralSection'
import { ModelSection } from './settings/ModelSection'
import { UsageSection } from './usage/UsageSection'
import { ActivitySection } from './usage/ActivitySection'
import { PermissionsSection } from './settings/PermissionsSection'
import { AppsSection } from './settings/AppsSection'
import { ChannelsSection } from './settings/channels/ChannelsSection'
import { PhoneDeviceActionsPage } from '../mobile/phone-device/PhoneDeviceActionsPage'
import { SettingsNav } from './settings/SettingsNav'
import { SessionSettingsSection } from './sessionpage/SessionSettingsSection'
import { ChevronLeft, X } from '@/lib/icons'
import { Sheet } from './ui/Sheet'
import { Pane, PaneHeader } from './ui/Pane'
import { IconButton } from './ui/IconButton'
import { platform } from '../platform'
import { UI_EVENTS } from '../lib/uiEvents'
import { appState } from '../session/renderer/lib/stores/app-state'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import {
  SETTINGS_SECTIONS,
  SESSION_HOST_SETTINGS_SECTIONS,
  type ActiveSection,
} from '@gugu/core/shared/enums/settingsSectionModels'
import { useTranslation } from 'react-i18next'

/**
 * 设置只有一份清单(core 的 SETTINGS_SECTION_GROUPS);哪台宿主显示哪几格只在这一道过滤里定(product spec),
 * ❌ 桌面手机各写一个判断:
 * - 「权限」只在读得到系统权限真值的宿主上(product spec);
 * - 「App」只在手机壳上:那里的 App 由这一页自己的 App 仓管(L9);桌面在最左栏的「App」里管,网页不装 App;
 * - 「聊天渠道」只在桌面版上:微信客户端跑在这台电脑的主进程里;
 * - 「这台手机」只在手机壳上(#7199 手机当设备:那几个动作要安卓的系统接口;桌面的「这台电脑能做的事」在「设备」里);
 * - 会话页那几格只在有会话页宿主的桌面形态上(它们是会话页的组件);手机「我的」不画。
 * - 「咕咕」组:云上可开通、已经有它、或桌面可在本机安家时显示;手机的连接应用复用资料页里的授权流程。
 */
const sectionsFor = (mobile: boolean): ActiveSection[] =>
  SETTINGS_SECTIONS.filter(
    (section) =>
      (section !== 'usage' || officialServicesEnabled()) &&
      (section !== 'permissions' || platform.systemPermissions.length > 0) &&
      (section !== 'apps' || platform.kind === 'capacitor') &&
      (section !== 'phone' || platform.kind === 'capacitor') &&
      (!SESSION_HOST_SETTINGS_SECTIONS.includes(section) || (mobile && section === 'connectors') || (!mobile && platform.capabilities.sessionHost)),
  )
const MOBILE_SECTIONS_FOR_PLATFORM = sectionsFor(true)
const DESKTOP_SECTIONS_FOR_PLATFORM = sectionsFor(false)
const ASSISTANT_SECTIONS: readonly ActiveSection[] = ['assistant', 'connectors']
/** 内页自己没有一句话说明的几页:由这里补在最上面(其余各页自己有,❌ 重复)。 */
const PAGE_LEDE_SECTIONS: readonly ActiveSection[] = ['general', 'activity']

/**
 * 会话页那几格的浮层(下拉、提示、确认框)落在 SessionSettingsSection 的浮层层里,不在壳的层栈(sheetStack)上:
 * 它们开着时这一下 Esc 归它们,弹窗留着,再按一次才关弹窗。Base UI 关掉的弹层仍挂在 `[hidden]` 下面,所以只算看得见的。
 */
const sessionOverlayOpen = (): boolean =>
  [...document.querySelectorAll('.gg-session-settings-layer [data-open]')].some((el) => !el.closest('[hidden]'))

// ─── SettingsPanel ────────────────────────────────────────────────────────────

export function SettingsPanel({ mobile = false, inline = false, onClose, initialSection = 'account', section, onSectionChange, pane, onPaneChange }: {
  mobile?: boolean
  // @@@1787 owner:「我的」是底部 tab 之一 → 移动端作 tab 页内联渲染(无 Sheet 壳),nav 层保留底部 tab 栏
  inline?: boolean
  onClose?: () => void
  initialSection?: ActiveSection
  // 弹窗形态由 MainLayout 受控:弹窗开着时别处再要一格(如「仓库」页机器选择器里的「添加一台机器」→ 设备),
  // 要的就是换到那一格 —— 只在挂载时读一次 initialSection 会把这次请求吞掉。
  section?: ActiveSection
  onSectionChange?: (section: ActiveSection) => void
  // inline 时 nav/detail 由 MainLayout 受控(tab 栏显隐 + 原生返回键都要读它)
  pane?: 'nav' | 'detail'
  onPaneChange?: (pane: 'nav' | 'detail') => void
}) {
  const { user, updateUser, logout } = useAuth()
  const { t } = useTranslation('main')
  const { contacts } = useContactsStore()
  const { cloudComputer } = useDevicesStore()
  const cloudAvailable = !!cloudComputer?.available
  const assistantName = useMyAssistantContact(contacts, cloudComputer?.snapshot?.deviceId).contact?.display_name ?? null
  const platformSections = mobile ? MOBILE_SECTIONS_FOR_PLATFORM : DESKTOP_SECTIONS_FOR_PLATFORM
  const assistantAvailable = cloudAvailable || !!assistantName || platform.capabilities.agentRuntime
  const sections = assistantAvailable ? platformSections : platformSections.filter((s) => !ASSISTANT_SECTIONS.includes(s))

  // @@@1507 初始 section 可由调用方指定(如侧栏「额度」直接开到 quota);缺省 account。
  const [internalSection, setInternalSection] = useState<ActiveSection>(initialSection)
  const activeSection = section ?? internalSection
  const setActiveSection = onSectionChange ?? setInternalSection
  const [internalPane, setInternalPane] = useState<'nav' | 'detail'>(mobile ? 'nav' : 'detail')
  const mobilePane = pane ?? internalPane
  const setMobilePane = onPaneChange ?? setInternalPane

  function renderSection() {
    switch (activeSection) {
      case 'assistant': return <AssistantSection available={sections} onOpenSection={selectSection} onOpenAssistantPage={openAssistantPage} />
      case 'connectors': return <ConnectorsSection />
      case 'account':  return <AccountSection user={user} updateUser={updateUser} logout={logout} />
      case 'general':  return <GeneralSection onOpenPermissions={() => selectSection('permissions')} />
      case 'devices':  return <DevicesSection onUpgrade={() => selectSection('usage')} />
      case 'model':    return <ModelSection />
      case 'usage':    return <UsageSection />
      case 'activity': return <ActivitySection />
      case 'about':    return <AboutSection />
      case 'permissions': return <PermissionsSection />
      case 'apps':     return <AppsSection />
      case 'channels': return <ChannelsSection />
      case 'phone':    return <PhoneDeviceActionsPage />
      case 'sessions':
      case 'interface':
      case 'resource-monitor':
      case 'repository':
      case 'browser':
      case 'subscriptions': return <SessionSettingsSection section={activeSection} />
      default:         return null
    }
  }

  // 咕咕那一页里指向助理 App 数据页(记忆、定时任务)的入口:先收起设置弹窗再去那一页。
  // 手机上助理是底部 tab(手机端那一套),设置「我的」里不给。
  const openAssistantPage = !mobile && onClose
    ? (tab: AssistantPageTab) => {
        onClose()
        window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
        appState.navigation.navigate('assistant', { tab })
      }
    : undefined

  const selectSection = (section: ActiveSection) => {
    if (mobile && section === 'connectors') {
      window.dispatchEvent(new Event(UI_EVENTS.openAssistantConnectors))
      return
    }
    setActiveSection(section)
    if (mobile) setMobilePane('detail')
  }

  // 内容区顶部条的标题:与 SettingsNav 里同一个 key 的导航项同一份翻译("账户"/"通用"/…)。
  const sectionTitle = t(`settings.nav.${activeSection}`)

  const card = (
      <div
        data-settings-modal-card
        data-mobile={mobile ? '' : undefined}
        data-settings-section={activeSection}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {(!mobile || mobilePane === 'nav') && (
          // inline(tab 页)时 nav 是顶层页,无出口箭头;仅弹窗形态(有 onClose)才给返回
          <SettingsNav activeSection={activeSection} sections={sections} mobile={mobile} user={user} assistantName={assistantName} onSelect={selectSection} onBack={mobile && onClose ? () => onClose() : undefined} />
        )}
        {(!mobile || mobilePane === 'detail') && (
          <Pane paneRole="detail" mobile={mobile} className="gg-settings-detail">
            <PaneHeader
              mobile={mobile}
              // 手机上同样写这一页自己的名字:「我的」是上一层,它已经由返回箭头(aria:返回我的)代表了;
              // 标题再写一遍「我的」,每一个设置子页都长一个样,人分不清自己在哪一页。
              title={sectionTitle}
              titleLevel={mobile ? 'panel' : undefined}
              leading={mobile ? (
                <IconButton size="lg" aria-label={t('settings.backToMy')} onClick={() => setMobilePane('nav')}>
                  <ChevronLeft />
                </IconButton>
              ) : undefined}
              actions={!mobile ? (
                // @@@1787 owner: ✗ 是桌面弹窗逻辑;移动端出口统一为左上返回箭头(SettingsNav onBack),✗ 只留桌面
                <IconButton aria-label={t('settings.close')} onClick={onClose}>
                  <X />
                </IconButton>
              ) : undefined}
            />
            {/* @@@6436 内页排版(桌面与手机的内边距差别也在内)全在 settings/settings.css。 */}
            <div className="gg-settings-body window-no-drag-region">
              {PAGE_LEDE_SECTIONS.includes(activeSection) ? <SettingsNote className="gg-settings-lede">{t(`settings.page.${activeSection}`)}</SettingsNote> : null}
              {renderSection()}
            </div>
          </Pane>
        )}
      </div>
  )

  // @@@settings-me (#537): 「添加我」QR 入口已随设置 nav 重构移出设置弹窗;
  // 展示我的 QR 仍在通讯录(ContactsPanel 用同一个 ContactQrShare)可达。

  // @@@1787 inline = 移动「我的」tab 页:平铺在 tab pane 里,不上 Sheet(底部 tab 栏由 MainLayout 渲染)
  if (inline) {
    return (
      <div
        data-testid={AUTOMATION_TEST_IDS.settingsPanel}
        aria-label={t('settings.my')}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--bg)' }}
      >
        {card}
      </div>
    )
  }

  // 顶层应用模态：Sheet portals 到 document.body，脱离 MainLayout 内 Sidebar/ChatListPanel
  // 的 stacking context，否则被它们内部的 fixed 高 z 弹窗盖住(#1182)。
  // --z-settings：高于所有工作区弹窗(modal/menu/banner/popover 全段)，
  // 低于 --z-overlay(图片预览) 与 --z-toast——设置内弹出的 toast/图片仍要可见。
  return (
    <Sheet
      onClose={() => onClose?.()}
      onEscape={sessionOverlayOpen}
      fullScreenMobile
      // @@@settings-size owner:「设置页太小了,可以大一点」——680x480 的卡片在 1440 宽的窗口里
      // 只占三成,会员档位/邀请链接这类横向内容被挤到换行、截断。放大到 1000x680(≈面积 2.1x)。
      // 宽度不写视口兜底:Sheet 自带 maxWidth:100%,窄窗口本来就会收缩它。高度必须自己兜——
      // desktopHeight 是硬高度,矮窗口(<744)不给 maxHeight 就会顶出屏幕(旧的 480 只是撞不上)。
      // ❌ 别写成 min(1000px, ...):jsdom 的 cssstyle 不解析 min(),整条声明会被丢成空,
      // 单测里 style.width 读出 '' —— 尺寸回归就没人守了(实测踩过)。
      // 2026-10-16 owner 又说「设置页偏小,放大一点」:字阶正文 13 → 14(settings.css),整块再放大一档到 1080x760。
      desktopWidth="1080px"
      desktopMaxHeight="calc(100dvh - 64px)" desktopHeight="760px"
      zIndex="var(--z-settings)"
      testId={AUTOMATION_TEST_IDS.settingsPanel}
      ariaLabel={t('settings.title')}
    >
      {/* 键盘焦点沿用共享 :focus-visible;桌面和手机仍是同一份设置。 */}
      {card}
    </Sheet>
  )
}
