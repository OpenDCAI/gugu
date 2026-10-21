import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

type BooleanSetter = Dispatch<SetStateAction<boolean>>
type TabSetter = Dispatch<SetStateAction<SidebarTab>>

export function useSessionpageAgentInstallNavigation(
  enabled: boolean,
  setAgentCreateDraftOpen: BooleanSetter,
  setAgentCreateDraftRetained: BooleanSetter,
  setSessionCreateOpen: BooleanSetter,
  setActiveTab: TabSetter,
) {
  useEffect(() => {
    if (!enabled) return
    const w = window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }
    w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = () => {
      setAgentCreateDraftOpen(false)
      setAgentCreateDraftRetained(false)
      setSessionCreateOpen(false)
      setActiveTab('tasks')
    }
    return () => {
      delete w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__
    }
  }, [enabled, setActiveTab, setAgentCreateDraftOpen, setAgentCreateDraftRetained, setSessionCreateOpen])
}
