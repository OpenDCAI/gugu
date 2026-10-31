import type { JSX } from 'react'
import { SETTINGS_GROUPS, type ActiveSection, type SettingsGroupId } from '@gugu/core/shared/enums/settingsSectionModels'
import type { AuthUser } from '../../store/auth'
import { Avatar } from '../Avatar'
import { CopyValue } from '../CopyValue'
import { Pane, PaneHeader } from '../ui/Pane'
import { ListRow } from '../ui/ListRow'
import { IconButton } from '../ui/IconButton'
import {
  Sparkles,
  SparklesFilled,
  Plug,
  PlugFilled,
  ChevronLeft,
  ChevronRight,
  Globe,
  GlobeFilled,
  Palette,
  PaletteFilled,
  Activity,
  Folder,
  FolderFilled,
} from '@/lib/icons'
import { useTranslation } from 'react-i18next'

interface NavItem {
  key: ActiveSection
  labelKey: string
  il: JSX.Element | null  // Solar linear (inactive)
  ib: JSX.Element | null  // Solar bold/filled (active)
}

interface SettingsNavProps {
  activeSection: ActiveSection
  sections: ActiveSection[]
  mobile?: boolean
  user: AuthUser | null
  onSelect: (section: ActiveSection) => void
  // @@@1787 手机导航规范(owner):页面出口=左上返回箭头,❌桌面式右上✗
  onBack?: () => void
  /** 咕咕那一组的小标题用它现在的名字(改过名就是新名);没读到就叫「咕咕」。 */
  assistantName?: string | null
}

// Solar Icon Set — linear (inactive) and bold/filled (active) variants

function IlAccount() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="6" r="4"/><ellipse cx="12" cy="17" rx="7" ry="4"/></g></svg>
}
function IbAccount() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="6" r="4" fill="currentColor"/><ellipse cx="12" cy="17" fill="currentColor" rx="7" ry="4"/></svg>
}

function IlGeneral() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" d="M20 7H4m16 5H4m16 5H4"/></svg>
}
function IbGeneral() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M3.464 20.536C4.93 22 7.286 22 12 22s7.071 0 8.535-1.465C22 19.072 22 16.714 22 12s0-7.071-1.465-8.536C19.072 2 16.714 2 12 2S4.929 2 3.464 3.464C2 4.93 2 7.286 2 12s0 7.071 1.464 8.535M18.75 16a.75.75 0 0 1-.75.75H6a.75.75 0 0 1 0-1.5h12a.75.75 0 0 1 .75.75M18 12.75a.75.75 0 0 0 0-1.5H6a.75.75 0 0 0 0 1.5zM18.75 8a.75.75 0 0 1-.75.75H6a.75.75 0 0 1 0-1.5h12a.75.75 0 0 1 .75.75" clipRule="evenodd"/></svg>
}

function IlDevices() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 9c0-2.828 0-4.243.879-5.121C3.757 3 5.172 3 8 3h8c2.828 0 4.243 0 5.121.879C22 4.757 22 6.172 22 9s0 4.243-.879 5.121C20.243 15 18.828 15 16 15H8c-2.828 0-4.243 0-5.121-.879C2 13.243 2 11.828 2 9Z"/><path strokeLinecap="round" d="M12 15v4m-4 0h8"/></g></svg>
}
function IbDevices() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M16 3H8C5.172 3 3.757 3 2.879 3.879C2 4.757 2 6.172 2 9s0 4.243.879 5.121C3.757 15 5.172 15 8 15h3.25v3.5H8a.75.75 0 0 0 0 1.5h8a.75.75 0 0 0 0-1.5h-3.25V15H16c2.828 0 4.243 0 5.121-.879C22 13.243 22 11.828 22 9s0-4.243-.879-5.121C20.243 3 18.828 3 16 3" clipRule="evenodd"/></svg>
}

function IlModel() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 11c0-3.771 0-5.657 1.172-6.828S6.229 3 10 3h4c3.771 0 5.657 0 6.828 1.172S22 7.229 22 11v2c0 3.771 0 5.657-1.172 6.828S17.771 21 14 21h-4c-3.771 0-5.657 0-6.828-1.172S2 16.771 2 13z"/><path strokeLinecap="round" d="M15 21V3"/></g></svg>
}
function IbModel() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M3.172 4.172C2 5.343 2 7.229 2 11v2c0 3.771 0 5.657 1.172 6.828S6.229 21 10 21h4.25V3H10C6.229 3 4.343 3 3.172 4.172M15.75 3.006v17.988c2.636-.027 4.104-.191 5.078-1.166C22 18.657 22 16.771 22 13v-2c0-3.771 0-5.657-1.172-6.828c-.974-.975-2.442-1.139-5.078-1.166" clipRule="evenodd"/></svg>
}


function IlAbout() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/><path stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" d="M12 17v-6"/><circle cx="1" cy="1" r="1" fill="currentColor" transform="matrix(1 0 0 -1 11 9)"/></g></svg>
}
function IbAbout() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2s10 4.477 10 10m-10 5.75a.75.75 0 0 0 .75-.75v-6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75M12 7a1 1 0 1 1 0 2a1 1 0 0 1 0-2" clipRule="evenodd"/></svg>
}

// Solar shield-check —— 手机「权限」页(product spec)
function IlPermissions() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 10.417c0-3.198 0-4.797.378-5.335c.377-.537 1.88-1.052 4.887-2.081l.573-.196C10.405 2.268 11.188 2 12 2s1.595.268 3.162.805l.573.196c3.007 1.029 4.51 1.544 4.887 2.081C21 5.62 21 7.22 21 10.417v1.574c0 5.638-4.239 8.375-6.899 9.536C13.38 21.842 13.02 22 12 22s-1.38-.158-2.101-.473C7.239 20.365 3 17.63 3 11.991z"/><path strokeLinecap="round" strokeLinejoin="round" d="m9.5 12.4l1.429 1.6l3.571-4"/></g></svg>
}
function IbPermissions() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M3.378 5.082C3 5.62 3 7.22 3 10.417v1.574c0 5.638 4.239 8.375 6.899 9.536c.721.315 1.082.473 2.101.473c1.02 0 1.38-.158 2.101-.473C16.761 20.365 21 17.63 21 11.991v-1.574c0-3.198 0-4.797-.378-5.335c-.377-.537-1.88-1.052-4.887-2.081l-.573-.196C13.595 2.268 12.812 2 12 2s-1.595.268-3.162.805L8.265 3c-3.007 1.03-4.51 1.545-4.887 2.082M15.06 10.5a.75.75 0 0 0-1.12-.999l-3.011 3.374l-.87-.974a.75.75 0 0 0-1.118 1l1.428 1.6a.75.75 0 0 0 1.119 0z" clipRule="evenodd"/></svg>
}

// 用量:三根柱 —— Solar「chart」同一套 1.5 线宽 / 圆角端点的画法
function IlUsage() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"><path d="M22 22H2"/><path d="M21 22V14.5A1.5 1.5 0 0 0 19.5 13h-3a1.5 1.5 0 0 0-1.5 1.5V22"/><path d="M15 22V5c0-1.414 0-2.121-.44-2.56C14.122 2 13.415 2 12 2s-2.121 0-2.56.44C9 2.878 9 3.585 9 5v17"/><path d="M9 22v-9.5A1.5 1.5 0 0 0 7.5 11h-3A1.5 1.5 0 0 0 3 12.5V22"/></g></svg>
}
function IbUsage() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" d="M9.44 2.44C9 2.878 9 3.585 9 5v16.25h6V5c0-1.414 0-2.121-.44-2.56C14.122 2 13.415 2 12 2s-2.121 0-2.56.44M7.5 11h-3A1.5 1.5 0 0 0 3 12.5v8.75h6V12.5A1.5 1.5 0 0 0 7.5 11m12 2h-3a1.5 1.5 0 0 0-1.5 1.5v6.75h6V14.5a1.5 1.5 0 0 0-1.5-1.5M2 21.25a.75.75 0 0 0 0 1.5h20a.75.75 0 0 0 0-1.5z"/></svg>
}

// 订阅:一张卡 —— Solar「card」,同一套 1.5 线宽画法(product spec)
function IlSubscriptions() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12c0-3.771 0-5.657 1.172-6.828S6.229 4 10 4h4c3.771 0 5.657 0 6.828 1.172S22 8.229 22 12s0 5.657-1.172 6.828S17.771 20 14 20h-4c-3.771 0-5.657 0-6.828-1.172S2 15.771 2 12Z"/><path strokeLinecap="round" d="M10 16H6m8 0h-1.5M2 10h20"/></g></svg>
}
function IbSubscriptions() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" d="M14 4h-4C6.229 4 4.343 4 3.172 5.172c-.844.843-1.08 2.057-1.146 4.078h19.948c-.066-2.021-.302-3.235-1.146-4.078C19.657 4 17.771 4 14 4m-4 16h4c3.771 0 5.657 0 6.828-1.172S22 15.771 22 12q0-.662-.002-1.25H2.002Q2 11.338 2 12c0 3.771 0 5.657 1.172 6.828S6.229 20 10 20m-4-4.75a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5zm6.5 0a.75.75 0 0 0 0 1.5H14a.75.75 0 0 0 0-1.5z"/></svg>
}

// App:四块圆角方格 —— Solar「widget」同一套 1.5 线宽画法(手机上从聊天装的 App,L9)
function IlApps() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><rect width="8" height="8" x="2.75" y="2.75" rx="2"/><rect width="8" height="8" x="13.25" y="2.75" rx="2"/><rect width="8" height="8" x="2.75" y="13.25" rx="2"/><rect width="8" height="8" x="13.25" y="13.25" rx="2"/></g></svg>
}
function IbApps() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="currentColor"><rect width="9.5" height="9.5" x="2" y="2" rx="2.5"/><rect width="9.5" height="9.5" x="12.5" y="2" rx="2.5"/><rect width="9.5" height="9.5" x="2" y="12.5" rx="2.5"/><rect width="9.5" height="9.5" x="12.5" y="12.5" rx="2.5"/></g></svg>
}

// 这台手机:Solar「smartphone」同一套 1.5 线宽画法(#7199 手机当设备,只在手机壳上)
function IlPhone() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 10c0-3.771 0-5.657 1.172-6.828S8.229 2 12 2s5.657 0 6.828 1.172S20 6.229 20 10v4c0 3.771 0 5.657-1.172 6.828S15.771 22 12 22s-5.657 0-6.828-1.172S4 17.771 4 14z"/><path strokeLinecap="round" d="M15 19H9"/></g></svg>
}
function IbPhone() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" fillRule="evenodd" d="M12.052 2h-.104c-1.68 0-3.01 0-4.052.142c-1.072.147-1.94.456-2.624 1.152s-.988 1.58-1.132 2.67C4 7.024 4 8.378 4 10.087v3.826c0 1.71 0 3.064.14 4.123c.144 1.09.448 1.974 1.132 2.67s1.552 1.005 2.624 1.152C8.937 22 10.268 22 11.948 22h.104c1.68 0 3.01 0 4.052-.142c1.072-.147 1.94-.456 2.624-1.152s.988-1.58 1.132-2.67c.14-1.06.14-2.414.14-4.123v-3.826c0-1.71 0-3.064-.14-4.123c-.144-1.09-.448-1.974-1.132-2.67s-1.552-1.005-2.624-1.152C15.063 2 13.732 2 12.052 2m-3.48 16.512a.69.69 0 0 1 .685-.698h5.486c.379 0 .686.312.686.698a.69.69 0 0 1-.686.697H9.257a.69.69 0 0 1-.686-.697" clipRule="evenodd"/></svg>
}

const NAV_ITEMS: NavItem[] = [
  // 咕咕那一组(owner 10-16):资料 = 它是谁与它的状态;连接应用 = 它连着的服务与设备上的数据。
  { key: 'assistant', labelKey: 'settings.nav.assistant', il: <Sparkles size={15} />, ib: <SparklesFilled size={15} /> },
  { key: 'connectors', labelKey: 'settings.nav.connectors', il: <Plug size={15} />, ib: <PlugFilled size={15} /> },
  { key: 'account', labelKey: 'settings.nav.account', il: <IlAccount />, ib: <IbAccount /> },
  { key: 'general', labelKey: 'settings.nav.general', il: <IlGeneral />, ib: <IbGeneral /> },
  { key: 'permissions', labelKey: 'settings.nav.permissions', il: <IlPermissions />, ib: <IbPermissions /> },
  { key: 'devices', labelKey: 'settings.nav.devices', il: <IlDevices />, ib: <IbDevices /> },
  { key: 'model',   labelKey: 'settings.nav.model', il: <IlModel />,   ib: <IbModel />   },
  { key: 'usage',   labelKey: 'settings.nav.usage', il: <IlUsage />,   ib: <IbUsage />   },
  { key: 'files', labelKey: 'settings.nav.files', il: <Folder size={15} />, ib: <FolderFilled size={15} /> },
  { key: 'subscriptions', labelKey: 'settings.nav.subscriptions', il: <IlSubscriptions />, ib: <IbSubscriptions /> },
  { key: 'apps',    labelKey: 'settings.nav.apps', il: <IlApps />,    ib: <IbApps />    },
  { key: 'phone',   labelKey: 'settings.nav.phone', il: <IlPhone />,   ib: <IbPhone />   },
  { key: 'about',   labelKey: 'settings.nav.about', il: <IlAbout />,   ib: <IbAbout />   },
  // 会话页画的那几格(product spec)。同一套 Solar linear / bold,尺寸与上面这些一样。
  { key: 'sessions', labelKey: 'settings.nav.sessions', il: null, ib: null },
  { key: 'interface', labelKey: 'settings.nav.interface', il: <Palette size={15} />, ib: <PaletteFilled size={15} /> },
  { key: 'resource-monitor', labelKey: 'settings.nav.resource-monitor', il: <Activity size={15} />, ib: <Activity size={15} /> },
  { key: 'browser', labelKey: 'settings.nav.browser', il: <Globe size={15} />, ib: <GlobeFilled size={15} /> },
]

export function SettingsNav({ activeSection, sections, mobile = false, user, assistantName, onSelect, onBack }: SettingsNavProps) {
  const { t } = useTranslation('main')
  // 按 core 那份分组排(桌面左栏与手机「我的」同一份);这台宿主不显示的格(sections 里没有)连同空组一起不画。
  const navGroups = SETTINGS_GROUPS
    .map((group) => ({ id: group.id, items: group.sections.flatMap((key) => (sections.includes(key) ? NAV_ITEMS.filter((item) => item.key === key) : [])) }))
    .filter((group) => group.items.length > 0)
  // 组名:「关于」组只有一格、名字与那一格同名,不画;其余都画(手机上咕咕组只剩「资料」一格,没有组名就不知道是谁的资料)。
  // 咕咕那组用它现在的名字。
  const captionFor = (id: SettingsGroupId): string | null =>
    id === 'about' ? null : id === 'assistant' ? (assistantName || t('settings.group.assistant')) : t(`settings.group.${id}`)

  return (
    // @@@ui-ruler 设置导航比会话列表窄是合理的(216 vs 240 --nav-col-w,#7333 视觉规范),但仍是同一把尺子的产物 —— 用
    // calc() 从 token 派生而不是裸写,窄多少一目了然,--nav-col-w 变了这里跟着变。
    <Pane
      paneRole="nav"
      mobile={mobile}
      className="gg-settings-nav-pane"
    >
      <PaneHeader
        title={mobile ? t('settings.my') : t('settings.title')}
        mobile={mobile}
        className="gg-settings-nav-header"
        leading={mobile && onBack ? (
          // @@@1787 手机导航规范(owner):出口=左上返回箭头(✗ 只留桌面)
          <IconButton size="lg" aria-label={t('settings.back')} onClick={onBack}>
            <ChevronLeft />
          </IconButton>
        ) : undefined}
      />

      {/* 账号条固定在上,下面的组自己滚(十几格之后整列一起滚会把头像条滚出去)。几何在 settings.css。 */}
      <div className="gg-settings-nav-body">
        {user && (
          <div className="gg-settings-identity">
            <div className="gg-settings-identity-avatar">
              <Avatar name={user.nickname} avatarUrl={user.avatarUrl} seed={user.id} size={mobile ? 'md' : 'sm'} />
            </div>
            <div className="gg-settings-identity-name" title={user.nickname}>
              {user.nickname}
            </div>
            <div className="gg-settings-identity-id">
              {typeof user.gugu_number === 'number' ? (
                <span className="gg-settings-identity-number">
                  <span>{t('settings.guguNumber')}</span>
                  <CopyValue value={String(user.gugu_number)} message={t('settings.guguNumberCopied')} />
                </span>
              ) : t('settings.guguNumberUnassigned')}
            </div>
          </div>
        )}

        <div className="gg-settings-nav-scroll" role="navigation" aria-label={mobile ? t('settings.my') : t('settings.title')}>
          {navGroups.map((group) => {
            const caption = captionFor(group.id)
            return (
              // 组与组之间靠留白 + 一行小标题分开(settings.css 的 gg-settings-nav-group)。
              <div key={group.id} role="group" aria-label={caption ?? undefined} className="gg-settings-nav-group" data-group={group.id}>
                {caption ? <div className="gg-settings-nav-caption" title={caption}>{caption}</div> : null}
                <div className="gg-settings-nav-group-items">
                {group.items.map(({ key, labelKey, il, ib }) => {
                  // mobile 是单栏入口列表,无「当前选中」概念(那是桌面双栏的态);detail 全屏盖住后高亮也无人看见
                  const isActive = !mobile && activeSection === key
                  return (
                    <ListRow
                      key={key}
                      // 导航项按 key 定位。按文案定位会两头翻车:换语言就找不到,而且有的分区标题
                      // 与导航项同名(会员与额度),按文本找会同时命中两个元素。
                      data-testid={`settings-nav-${key}`}
                      className="gg-settings-nav-item"
                      role="button"
                      tabIndex={0}
                      aria-current={isActive ? 'page' : undefined}
                      leading={(isActive ? ib : il) ?? <span className="gg-settings-nav-spacer" aria-hidden="true" />}
                      title={t(labelKey)}
                      selected={isActive}
                      // #7333 桌面左栏是导航:胶囊行。手机「我的」是整屏入口列表,不是导航胶囊。
                      variant={mobile ? undefined : 'nav'}
                      mobile={mobile}
                      // 手机上这是一张整屏换页的入口列表:每行末尾一枚 ›,说明「点进去是另一页」。
                      // 没有它,六行字看着像一段说明文字,而不是能按的东西。桌面是左右两栏,点了右边就换,不需要。
                      meta={mobile ? <ChevronRight size={16} aria-hidden="true" className="text-[var(--faint-fg)]" /> : undefined}
                      onClick={() => onSelect(key)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || event.defaultPrevented) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelect(key)
                        }
                      }}
                    />
                  )
                })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Pane>
  )
}
