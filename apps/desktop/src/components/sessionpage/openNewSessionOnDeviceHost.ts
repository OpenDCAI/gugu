import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { handOverToSessionpage, HOST_OPEN_NEW_SESSION_KEY, type NewSessionBridgeWindow } from '../../lib/sessionpageNewSessionBridge'

/**
 * #6264 主渲染层那一半(见 lib/sessionpageNewSessionBridge.ts):设置里装好一台机器后点「在这台机器上新建任务」
 * → 关掉设置、切到「任务」tab,新建页预选那台机器。只在有会话页的装配里挂(桌面)。
 */
export function useOpenNewSessionOnDeviceHost(
  enabled: boolean,
  setSettingsModalOpen: Dispatch<SetStateAction<boolean>>,
  setActiveTab: (tab: SidebarTab) => void,
) {
  useEffect(() => {
    if (!enabled) return
    const w = window as unknown as NewSessionBridgeWindow
    const open = (deviceId: string) => {
      setSettingsModalOpen(false)
      setActiveTab('tasks')
      handOverToSessionpage(w, deviceId)
    }
    w[HOST_OPEN_NEW_SESSION_KEY] = open
    return () => {
      if (w[HOST_OPEN_NEW_SESSION_KEY] === open) delete w[HOST_OPEN_NEW_SESSION_KEY]
    }
  }, [enabled, setActiveTab, setSettingsModalOpen])
}
