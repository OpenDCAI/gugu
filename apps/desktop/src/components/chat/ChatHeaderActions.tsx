import { useRef, useState, type RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useChatFolderName } from './chatFolderName'
import { Folder, LayoutGrid, MoreHorizontal, Search, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { resourceMenuItems } from '@/lib/resourceActions'
import { OpenAppMenuItems } from './OpenAppMenuItems'
import { openApp } from '../appSlot/useOpenApp'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { RailAppIcon } from '../RailAppIcon'
import { GroupAppsPicker } from './GroupAppsPicker'
import { useChatAppPins } from './useChatAppPins'
import { useHeaderAppCapacity } from './useHeaderAppCapacity'
import { ChatDetailsMenuItems } from './ChatDetailsMenuItems'


// #1234 消息头右上的 action icon。
//
// @@@ui-ruler 这里原本手写 `mheadIconClass`(32 网格 + `.gg-ghost` + `max-[719px]:size-11`),
// 那正好**逐条等于** ui/IconButton —— 图标钮的唯一实现(尺寸取 --control-h-*、图标取 --icon-*、
// 三态与 data-on 来自 .gg-ghost)。本地副本删除,触控档归 IconButton 自己(它读 useMobileShell,
// Capacitor 原生壳也命中)。

interface ChatHeaderActionsProps {
  isGroupChat: boolean
  // @@@5856 「场所型」会话 = 群 + 话题(isRoomChat)。搜索/成员这两颗按钮问的是「这是不是一个
  // 有自己名字、自己成员的场所」,不是「这是不是群」⇒ 话题一样要有。工作区不问这个:私聊也有自己的文件。
  // ⋯ 菜单里的群公告仍按 isGroupChat 分叉(话题没有公告)。
  isRoomChat: boolean
  searchMode: boolean
  /** The panel is up and shows the folder (a tab like any other: owner 10-24) — not just「the panel is open」. */
  folderShown: boolean
  /** The chat's info tab (members, announcement, settings) is on screen. */
  infoShown: boolean
  showHeaderMenu: boolean
  mobile?: boolean
  /** 画在会话页一块的页签条上时(没有标题后面的「(N)」):人数挂在成员按钮上。 */
  memberCount?: number
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onEnterSearchMode: () => void
  /** The folder opened, or brought forward when it is a tab already. */
  onOpenFolder: () => void
  onCloseWorkspacePanel: () => void
  /** The chat's info beside it; the members' button opens it at their list. */
  onOpenInfo: (page?: 'main' | 'members') => void
  onCloseInfo: () => void
  onToggleHeaderMenu: () => void
  onCloseHeaderMenu: () => void
}

export const ChatHeaderActions = observer(function ChatHeaderActions({
  isGroupChat,
  isRoomChat,
  searchMode,
  folderShown,
  infoShown,
  showHeaderMenu,
  mobile,
  memberCount,
  moreButtonRef,
  onEnterSearchMode,
  onOpenFolder,
  onCloseWorkspacePanel,
  onOpenInfo,
  onCloseInfo,
  onToggleHeaderMenu,
  onCloseHeaderMenu,
}: ChatHeaderActionsProps) {
  const { t } = useTranslation('messaging')
  const { activeChatId } = useChatStore('activeChatId')
  const folderName = useChatFolderName(activeChatId) // 群文件夹 / 文件夹 (chatFolderName.ts)
  const openFolder = onOpenFolder
  const compactRoom = Boolean(mobile && isRoomChat) // 手机群聊页头只留成员 + ⋯,搜索/文件夹/群 Apps 收进 ⋯。
  const groupId = isGroupChat ? activeChatId : null
  const pins = useChatAppPins(groupId)
  const apps = installedExtensionsStore.openableApps
  const pinnedApps = pins.ids.flatMap((id) => apps.find((app) => app.extensionId === id) ?? [])
  const { ref: pinsRef, capacity } = useHeaderAppCapacity(pinnedApps.length, compactRoom || !groupId)
  const overflow = pinnedApps.slice(capacity)
  const appsButton = useRef<HTMLButtonElement>(null)
  const [picker, setPicker] = useState({ chatId: activeChatId, open: false })
  if (picker.chatId !== activeChatId) setPicker({ chatId: activeChatId, open: false })
  const openApps = () => { onCloseHeaderMenu(); setPicker({ chatId: activeChatId, open: true }) }
  return (
    <Popover.Root open={picker.open && !mobile} modal={false} onOpenChange={(open) => setPicker({ chatId: activeChatId, open })}>
      {groupId && !compactRoom && <>
        <span ref={pinsRef} className="flex items-center gap-[2px]">
          {pinnedApps.slice(0, capacity).map((app) => <IconButton key={app.extensionId} data-testid={AUTOMATION_TEST_IDS.chatHeaderPinnedApp} data-app-id={app.extensionId} aria-label={app.name} title={app.name} onClick={() => openApp(app.extensionId, groupId)}><RailAppIcon app={app} className="gg-sidebar-launch-icon" /></IconButton>)}
        </span>
        <Popover.Trigger ref={appsButton} data-testid={AUTOMATION_TEST_IDS.chatHeaderAppsButton} onClick={onCloseHeaderMenu} render={<IconButton aria-label={t('header.groupApps')} title={t('header.groupApps')} on={picker.open || undefined}><LayoutGrid /></IconButton>} />
      </>}
      {/* @@@1161 会话头右上 action icon 行(aria-label key 在 chatHeader 命名空间):
            searchMessages(在对话中搜索) · widgetList(工作区) · memberList(成员列表) · moreActions(更多操作)。
          全部走 Solar 图标族(@/lib/icons):
            pins / LayoutGrid(群 Apps) / Search / Folder(文件夹) / Users / MoreHorizontal。
          #1102 曾把搜索塞进 ⋯,搜索应是头栏顶层 icon,故恢复为顶层。 */}
      {/* 搜索 — #1323 模块2:顶栏搜索 icon 仅场所型会话保留,DM 的「搜索聊天」放在 ⋯ 下拉里。 */}
      {isRoomChat && !compactRoom && (
        <IconButton
          data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchButton}
          on={searchMode || undefined}
          title={t('header.searchConversation')}
          aria-label={t('header.searchConversation')}
          aria-pressed={searchMode}
          onClick={onEnterSearchMode}
        >
          <Search />
        </IconButton>
      )}
      {/* 文件夹。群、话题、私聊都有(主人 10-05「私聊也是得有面板的」):
          每个对话都有自己的云端文件和右栏。手机群聊收进 ⋯(见 compactRoom),手机私聊图标少,留在页头。 */}
      {!compactRoom && (
        <IconButton
          on={folderShown || undefined}
          title={folderName}
          aria-label={folderName}
          aria-pressed={folderShown}
          onClick={() => {
            if (folderShown) onCloseWorkspacePanel()
            else openFolder()
          }}
        >
          <Folder />
        </IconButton>
      )}
      {/* 成员 — 打开群信息页签,落在成员那一页(owner 10-26:成员、公告、设置合成一处,同 Slack 点头像堆落在成员)。
          @@@5856 成员列表本身必须有入口(owner 2026-09-18):这颗钮直接到名单,不是到设置的第一页。群与话题都有。 */}
      {isRoomChat && (
        <IconButton
          data-testid={AUTOMATION_TEST_IDS.chatHeaderMembersButton}
          on={infoShown || undefined}
          title={t('header.memberList')}
          aria-label={t('header.memberList')}
          aria-pressed={infoShown}
          onClick={() => {
            if (infoShown) onCloseInfo()
            else onOpenInfo('members')
          }}
        >
          <Users />
          {memberCount !== undefined && <span data-member-count="">{memberCount}</span>}
        </IconButton>
      )}
      {/* Settings stays reachable from More in every layout, independently of pinned Apps. */}
      <DropdownMenu.Root
        open={showHeaderMenu}
        modal={false}
        onOpenChange={(open) => {
          if (open) onToggleHeaderMenu()
          else onCloseHeaderMenu()
        }}
      >
        <DropdownMenu.Trigger
          ref={moreButtonRef}
          data-testid={AUTOMATION_TEST_IDS.chatHeaderMoreButton}
          title={t('header.more')}
          aria-haspopup="menu"
          aria-pressed={showHeaderMenu}
          render={(
            <IconButton
              on={showHeaderMenu || undefined}
              aria-label={t('header.more')}
            >
              <MoreHorizontal />
            </IconButton>
          )}
        />
        {showHeaderMenu && (
          <DropdownMenu.Content
            data-testid={AUTOMATION_TEST_IDS.groupHeaderMenu}
            side="bottom"
            align="end"
            sideOffset={4}
            style={{ minWidth: 148 }}
          >
            {compactRoom && (<>
              <MenuItem data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchButton} onClick={onEnterSearchMode} icon={<Search size={16} />}>{t('header.searchConversation')}</MenuItem>
              <MenuItem onClick={openFolder} icon={<Folder size={16} />}>{folderName}</MenuItem>
            </>)}
            {!isGroupChat && !compactRoom && <MenuItem
                  render={<button type="button" />}
                  nativeButton
                  data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchButton}
                  onClick={onEnterSearchMode}
                  icon={<Search size={16} />}
                >{t('header.searchChat')}</MenuItem>}
            {activeChatId && resourceMenuItems({ kind: 'chat', target: { kind: 'chat', chatId: activeChatId } }).map(item => <MenuItem key={item.id} onClick={() => { onCloseHeaderMenu(); void item.click() }}>{item.label}</MenuItem>)}
            <ChatDetailsMenuItems isGroupChat={isGroupChat} onOpenInfo={() => isGroupChat ? onOpenInfo('main') : onOpenInfo()} />
            {/* 「在本群打开」的常驻入口:话题的分栏与手机整页同一份(OpenAppMenuItems)。 */}
            {groupId ? <OpenAppMenuItems chatId={groupId} apps={overflow} separated /> : activeChatId && <OpenAppMenuItems chatId={activeChatId} separated />}
            {groupId && compactRoom && <MenuItem onClick={openApps} icon={<LayoutGrid size={16} />}>{t('header.groupApps')}</MenuItem>}
          </DropdownMenu.Content>
        )}
      </DropdownMenu.Root>
      {groupId && picker.open && <GroupAppsPicker chatId={groupId} pins={pins} mobile={mobile} anchor={compactRoom ? moreButtonRef : appsButton} onClose={() => setPicker({ chatId: activeChatId, open: false })} />}
    </Popover.Root>
  )
})
