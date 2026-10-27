import { useRef, useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, MoreHorizontal } from '@/lib/icons'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { resourceMenuItems } from '@/lib/resourceActions'
import { OpenAppMenuItems } from './OpenAppMenuItems'
import { GroupAppsPicker } from './GroupAppsPicker'
import { useChatAppPins } from './useChatAppPins'
import { useChatStore } from '../../store/chatContext'
import { ChatDetailsMenuItems } from './ChatDetailsMenuItems'
import { openInfoTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'

/**
 * A topic's ⋯ (TopicSplitPane), the group header's menu over again (ChatHeaderActions): on the phone what its header has
 * no room for (`items`, as a group's compact header folds them in), then the Apps that open in the source chat's panel. With
 * Settings and announcements belong to the source conversation.
 */
export const TopicMoreMenu = observer(function TopicMoreMenu({ chatId, resourceChatId = chatId, mobile, items }: {
  chatId: string
  resourceChatId?: string
  mobile: boolean
  items?: ReactNode
}) {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  const groupId = chats.find((chat) => chat.id === chatId)?.kind === 'group' ? chatId : null
  const pins = useChatAppPins(groupId)
  const [appsOpen, setAppsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const apps = installedExtensionsStore.openableApps
  const pinned = pins.ids.flatMap((id) => apps.find((app) => app.extensionId === id) ?? [])
  return (
    <Popover.Root open={appsOpen} modal={false} onOpenChange={setAppsOpen}>
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger
        ref={anchor}
        data-testid="topic-split-more"
        title={t('header.more')}
        aria-haspopup="menu"
        render={(
          <IconButton size={mobile ? 'md' : 'sm'} tone="strong" aria-label={t('header.more')}>
            <MoreHorizontal size={16} />
          </IconButton>
        )}
      />
      <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-[148px]">
        {resourceMenuItems({ kind: 'chat', target: { kind: 'chat', chatId: resourceChatId } }).map(item => <MenuItem key={item.id} onClick={() => { setMenuOpen(false); void item.click() }}>{item.label}</MenuItem>)}
        {items}
        <ChatDetailsMenuItems isGroupChat={Boolean(groupId)} onOpenInfo={() => openInfoTab(chatId, groupId ? 'main' : undefined)} />
        {groupId ? <>
          <MenuItem icon={<LayoutGrid size={16} />} onClick={() => { setMenuOpen(false); setAppsOpen(true) }}>{t('header.groupApps')}</MenuItem>
          <OpenAppMenuItems chatId={groupId} apps={pinned} separated />
        </> : <OpenAppMenuItems chatId={chatId} separated={Boolean(items)} />}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {groupId && appsOpen && <GroupAppsPicker chatId={groupId} pins={pins} mobile={mobile} anchor={anchor} onClose={() => setAppsOpen(false)} />}
    </Popover.Root>
  )
})
