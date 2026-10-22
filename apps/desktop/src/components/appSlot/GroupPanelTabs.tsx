import { observer } from 'mobx-react-lite'
import { useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, Paperclip, Plus } from '@/lib/icons'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { parseExtensionTabKind } from '../../session/shared/extensions/manifest'
import { TabChip, TabSlot } from '../../session/renderer/features/tabs/tab-bar/tab-chip'
import { useChatFolderName } from '../chat/chatFolderName'
import { OpenAppMenuItems } from '../chat/OpenAppMenuItems'
import { RailAppIcon } from '../RailAppIcon'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem } from '../ui/Menu'
import { groupSlotMemory, type OpenedWith } from './groupSlotMemory'

/**
 * 群右栏开着的东西在块页签条上的那几枚(gugu-dev#181 第 ⑥ 步):群文件夹、App 的页、在 App 里开的文件,按打开先后排,
 * 点哪枚右栏就是哪枚,× 把它从开着的里拿掉(拿掉的是正看着的就换到旁边那枚,一枚不剩右栏就关);后面一颗「+」只列
 * 群文件夹和能在群里开的 App。右栏照旧只画正看着的那一枚(GroupAppSlot),这里只是把开着的列出来。
 */
export const GroupPanelTabs = observer(function GroupPanelTabs({ chatId, onShowPanel, onClosePanel }: {
  chatId: string
  /** 右栏关着时点「+」里的群文件夹:先把右栏打开。 */
  onShowPanel: () => void
  /** 最后一枚也关了:右栏关上(与右栏自己的 × 同一个口子)。 */
  onClosePanel: () => void
}) {
  const { t } = useTranslation('messaging')
  const tabs = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.tabs(chatId))
  const active = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.opened(chatId))
  const plusRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      {tabs.map((item) => (
        <PanelTab
          key={item ? `${item.kind ?? 'preview'}:${item.itemId ?? ''}` : 'folder'}
          chatId={chatId}
          item={item}
          active={item === active}
          onPick={() => groupSlotMemory.activate(chatId, item)}
          onClose={() => {
            groupSlotMemory.close(chatId, item)
            if (groupSlotMemory.tabs(chatId).length === 0) onClosePanel()
          }}
          closeLabel={t('common.close')}
        />
      ))}
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
              onShowPanel()
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

const PanelTab = observer(function PanelTab({ chatId, item, active, onPick, onClose, closeLabel }: {
  chatId: string
  item: OpenedWith | null
  active: boolean
  onPick: () => void
  onClose: () => void
  closeLabel: string
}) {
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
        onClick={onPick}
      />
    </TabSlot>
  )
})
