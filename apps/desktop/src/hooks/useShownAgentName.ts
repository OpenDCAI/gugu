import { agentNamingUntil } from '@gugu/core/shared/agentDefaultName'
import { useTranslation } from 'react-i18next'
import { useDeadlineClock } from './useDeadlineClock'
import { useChatClashNames } from '../components/chat/ChatClashNames'

type AgentNameInput = {
  name: string
  agentType?: string | null
  createdAt: string | number | undefined
  id?: string | null
  chatId?: string | null
}
export function useShownAgentName(input: AgentNameInput): string
export function useShownAgentName(input: readonly AgentNameInput[]): string[]
export function useShownAgentName(input: AgentNameInput | readonly AgentNameInput[]): string | string[] {
  const { t } = useTranslation('common')
  const scope = useChatClashNames()
  const names: readonly AgentNameInput[] = Array.isArray(input) ? input : [input as AgentNameInput]
  const now = Date.now()
  const deadlines = names.map(({ name, agentType, createdAt }) => agentNamingUntil(name, agentType, createdAt, now))
  const active = deadlines.filter((until): until is number => until !== null)
  useDeadlineClock(active.length ? Math.min(...active) : null)
  const shown = names.map(({ name, id, chatId }, index) => deadlines[index] === null ? (id && (chatId === undefined || chatId === scope.chatId) ? scope.names.get(id) ?? name : name) : t('agentName.naming'))
  return Array.isArray(input) ? shown : shown[0]!
}
