import { useMemo } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useStableHandler } from './useStableHandler'

/** 一列 agent 行共用的那一份动作:身份不随父组件重渲染而换,行(memo)才认得出「我这一行没变」。 */
export type AgentRowActions = {
  onSelect: (contact: ContactUser) => void
  onToggleSelection: (contact: ContactUser) => void
  onStartChat?: (contact: ContactUser) => void
  onPin: (contact: ContactUser) => void
  onMarkUnread: (contact: ContactUser) => void
  onToggleNotif: (contact: ContactUser) => void
  onRemove: (contact: ContactUser) => void
}

export function useAgentRowActions(handlers: Pick<AgentRowActions, 'onSelect'> & Partial<AgentRowActions>): AgentRowActions {
  const onSelect = useStableHandler(handlers.onSelect)
  const onToggleSelection = useStableHandler((contact: ContactUser) => handlers.onToggleSelection?.(contact))
  const onStartChat = useStableHandler((contact: ContactUser) => handlers.onStartChat?.(contact))
  const onPin = useStableHandler((contact: ContactUser) => handlers.onPin?.(contact))
  const onMarkUnread = useStableHandler((contact: ContactUser) => handlers.onMarkUnread?.(contact))
  const onToggleNotif = useStableHandler((contact: ContactUser) => handlers.onToggleNotif?.(contact))
  const onRemove = useStableHandler((contact: ContactUser) => handlers.onRemove?.(contact))
  const canStartChat = !!handlers.onStartChat
  return useMemo(
    () => ({ onSelect, onToggleSelection, onStartChat: canStartChat ? onStartChat : undefined, onPin, onMarkUnread, onToggleNotif, onRemove }),
    [canStartChat, onSelect, onToggleSelection, onStartChat, onPin, onMarkUnread, onToggleNotif, onRemove],
  )
}
