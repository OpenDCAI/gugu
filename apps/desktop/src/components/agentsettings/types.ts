import type { ContactUser } from '@gugu/core/shared/types/contacts'

export interface AgentSettingsPaneProps {
  agent: ContactUser
  onClose?: () => void
  /** 跳到设置里的另一页(资料页「打开形象工坊」用)。 */
  onOpenTab?: (tab: AgentSettingsTab) => void
}

export type AgentSettingsTab =
  | 'profile'
  | 'look'
  | 'share-act'
  | 'history'
  | 'contacts'
  | 'tasks'
  | 'finance'
  | 'aimodel'
  | 'memory'
  | 'permissions'
  | 'secrets'
