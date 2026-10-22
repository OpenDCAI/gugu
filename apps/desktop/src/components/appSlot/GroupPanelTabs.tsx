import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, Maximize2, Minimize2, Paperclip, Plus } from '@/lib/icons'
import { subscribeShellChatActions, takeShellChatAction, type ShellChatAction } from '@/lib/sidebarChatsBridge'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { parseExtensionTabKind } from '../../session/shared/extensions/manifest'
import { TabChip, TabSlot } from '../../session/renderer/features/tabs/tab-bar/tab-chip'
import { useChatFolderName } from '../chat/chatFolderName'
import { OpenAppMenuItems } from '../chat/OpenAppMenuItems'
import { TopicTab } from '../chat/TopicSplitPane'
import { RailAppIcon } from '../RailAppIcon'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem } from '../ui/Menu'
import { groupSlotMemory, type OpenedWith } from './groupSlotMemory'

/**
 * 群右栏开着的东西在块页签条上的那几枚(gugu-dev#181 第 ⑥ 步):群文件夹、App 的页、在 App 里开的文件,按打开先后排,
 * 点哪枚右栏就是哪枚,× 把它从开着的里拿掉(拿掉的是正看着的就换到旁边那枚,一枚不剩右栏就关);后面一颗「+」只列
 * 群文件夹和能在群里开的 App。右栏照旧只画正看着的那一枚(GroupAppSlot),这里只是把开着的列出来。
 * 右边一次只摆一样(#1312):话题分栏上来时右栏的这几枚还在、不亮,右栏上来时话题那一枚也一样(分栏开着时它由分栏画);
 * 点群那一枚右边让开,这几枚都还在。开着哪几枚、哪枚正显示,只读 groupSlotMemory。
 */
export const GroupPanelTabs = observer(function GroupPanelTabs({ chatId, onShowPanel, onClosePanel, onShowTopic, onShowChatAlone }: {
  chatId: string
  /** 右栏以这一种样子上来(旁边 / 占满);话题分栏或别的右侧面板正开着就先让开。 */
  onShowPanel: (form: 'side' | 'full') => void
  /** 最后一枚也关了:右栏关上(与右栏自己的 × 同一个口子)。 */
  onClosePanel: () => void
  /** 不亮的话题那一枚点了:分栏回来。 */
  onShowTopic: (topic: { chatId: string; name: string }) => void
  /** 群那一枚点了(会话页那棵树经 requestShellChatAction 转过来):右边全让开。 */
  onShowChatAlone: () => void
}) {
  const { t } = useTranslation('messaging')
  const tabs = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.tabs(chatId))
  const active = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.opened(chatId))
  const form = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.form(chatId))
  const topic = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.topic(chatId))
  const plusRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const showAlone = useRef(onShowChatAlone)
  showAlone.current = onShowChatAlone
  useEffect(() => {
    const mine = (action: ShellChatAction): action is Extract<ShellChatAction, object> => typeof action === 'object' && action.chatId === chatId
    const take = () => { if (takeShellChatAction(mine)) showAlone.current() }
    take()
    return subscribeShellChatActions(take)
  }, [chatId])
  return (
    <>
      {topic && !topic.shown ? <TopicTab name={topic.name} chatId={topic.chatId} onPick={() => onShowTopic(topic)} /> : null}
      {tabs.map((item) => {
        const shown = form !== 'closed' && item === active
        return (
          <PanelTab
            key={item ? `${item.kind ?? 'preview'}:${item.itemId ?? ''}` : 'folder'}
            chatId={chatId}
            item={item}
            active={shown}
            full={shown && form === 'full'}
            onPick={(as) => {
              groupSlotMemory.activate(chatId, item)
              if (as || form === 'closed') onShowPanel(as ?? 'side')
            }}
            onClose={() => {
              groupSlotMemory.close(chatId, item)
              if (groupSlotMemory.tabs(chatId).length === 0) onClosePanel()
            }}
            closeLabel={t('common.close')}
          />
        )
      })}
      <span className="flex h-full shrink-0 items-center px-1">
        <IconButton ref={plusRef} size="sm" aria-label={t('header.openInGroup')} title={t('header.openInGroup')} data-testid="block-panel-plus" on={menuOpen || undefined} onClick={() => setMenuOpen(true)}>
          <Plus />
        </IconButton>
      </span>
      {menuOpen ? (
        <Menu anchor={plusRef} onClose={() => setMenuOpen(false)}>
          <MenuItem
            icon={<LayoutGrid size={16} />}
            onClick={() => {
              groupSlotMemory.activate(chatId, null)
              onShowPanel(form === 'full' ? 'full' : 'side')
            }}
          >
            <FolderName chatId={chatId} />
          </MenuItem>
          <OpenAppMenuItems chatId={chatId} separated />
        </Menu>
      ) : null}
    </>
  )
})

function FolderName({ chatId }: { chatId: string }) {
  return <>{useChatFolderName(chatId)}</>
}

/** 一枚右栏的页签;右键菜单里是「展开 / 还原」(格子里右栏自己不再有那一行页头)。 */
const PanelTab = observer(function PanelTab({ chatId, item, active, full, onPick, onClose, closeLabel }: {
  chatId: string
  item: OpenedWith | null
  active: boolean
  full: boolean
  /** 点了(`as` 不给)或右键里选了展开 / 还原(`as` = 右栏要成的样子)。 */
  onPick: (as?: 'side' | 'full') => void
  onClose: () => void
  closeLabel: string
}) {
  const { t } = useTranslation('messaging')
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const folderName = useChatFolderName(chatId)
  const extensionId = item?.kind ? parseExtensionTabKind(item.kind)?.extensionId : undefined
  const app = extensionId ? installedExtensionsStore.openableApps.find((candidate) => candidate.extensionId === extensionId) : undefined
  const label = item ? item.title : folderName
  return (
    <TabSlot data-panel-tab={item ? item.kind ?? 'preview' : 'folder'}>
      <TabChip
        isActive={active}
        label={label}
        preSlot={item === null ? <LayoutGrid size={14} /> : app ? <RailAppIcon app={app} className="size-4" /> : <Paperclip size={14} />}
        closeLabel={`${closeLabel} ${label}`}
        onClose={onClose}
        onClick={() => onPick()}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuAt({ x: event.clientX, y: event.clientY })
        }}
      />
      {menuAt ? (
        <Menu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>
          <MenuItem data-testid="block-panel-tab-full" icon={full ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onClick={() => onPick(full ? 'side' : 'full')}>
            {t(full ? 'chatArea.openWith.restore' : 'chatArea.openWith.maximize')}
          </MenuItem>
        </Menu>
      ) : null}
    </TabSlot>
  )
})
