import { observer } from 'mobx-react-lite'
import { installedExtensionsStore, type RailApp } from '../../session/renderer/features/extensions/installed-extensions-store'
import { openApp } from '../appSlot/useOpenApp'
import { RailAppIcon } from '../RailAppIcon'
import { MenuItem, MenuSeparator } from '../ui/Menu'

/**
 * 「在本群打开」(app-redesign §5)的常驻入口:卡片划走以后,这台设备上装着、开着、有自己页面的 App 仍从页头 ⋯ 在这个对话的右栏
 * 打开 —— 群和私聊的页头(ChatHeaderActions);走卡片「打开」的同一条 `openApp`。
 * 列表与最左栏右键「App」同一份(`openableApps`)。没有可开的 App 时什么都不画。
 */
export const OpenAppMenuItems = observer(function OpenAppMenuItems({ chatId, separated, apps = installedExtensionsStore.openableApps }: {
  chatId: string
  /** 前面还有别的菜单项:先画一条分组线。 */
  separated?: boolean
  apps?: readonly RailApp[]
}) {
  if (apps.length === 0) return null
  return (
    <>
      {separated && <MenuSeparator />}
      {apps.map((app) => (
        <MenuItem
          key={app.extensionId}
          data-testid="chat-header-menu-app"
          onClick={() => openApp(app.extensionId, chatId)}
          icon={<RailAppIcon app={app} className="gg-sidebar-launch-icon" />}
        >{app.name}</MenuItem>
      ))}
    </>
  )
})
