import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

type BooleanSetter = Dispatch<SetStateAction<boolean>>
type TabSetter = (tab: SidebarTab) => void

export function useSessionpageAgentInstallNavigation(
  enabled: boolean,
  setSessionCreateOpen: BooleanSetter,
  setActiveTab: TabSetter,
) {
  useEffect(() => {
    if (!enabled) return
    const w = window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }
    w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = () => {
      setSessionCreateOpen(false)
      setActiveTab('tasks')
    }
    return () => {
      delete w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__
    }
  }, [enabled, setActiveTab, setSessionCreateOpen])
}
