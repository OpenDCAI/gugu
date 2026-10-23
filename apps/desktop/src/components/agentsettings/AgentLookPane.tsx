import { useMemo } from 'react'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { agentIdentity } from '../agentAvatar/engine/identity'
import { parseAgentLook, resolveAgentLook, wornOf } from '../agentAvatar/look'
import type { AgentSettingsPaneProps } from './types'
import { AgentLookEditor } from './AgentLookEditor'

/** 已有 Agent 的形象存储接入；首开引导复用同一编辑器，将选择保留在开通草稿中。 */
export function AgentLookPane({ agent }: AgentSettingsPaneProps) {
  const { contacts, setAgentLook } = useContactsStore()
  const { user } = useAuth()
  const stored = parseAgentLook(agent.avatar)
  const siblings = useMemo(() => contacts
    .filter((c) => c.type === 'agent' && c.id !== agent.id && !!agent.owner_user_id && c.owner_user_id === agent.owner_user_id)
    .filter((c) => c.avatar == null || parseAgentLook(c.avatar) != null)
    .map((c) => {
      const look = resolveAgentLook(c.id, c.avatar)
      return { name: c.display_name, look: { ...look, wear: wornOf(look, c.id) } }
    }), [contacts, agent.id, agent.owner_user_id])

  return (
    <AgentLookEditor
      id={agent.id}
      name={agent.display_name}
      number={agent.gugu_number}
      current={stored ?? agentIdentity(agent.id)}
      hasSavedLook={stored != null}
      usesPhoto={agent.avatar != null && !stored}
      isOwned={agent.type === 'agent' && !!agent.owner_user_id && agent.owner_user_id === user?.id}
      siblings={siblings}
      onSave={async (look) => { await setAgentLook(agent.id, look) }}
    />
  )
}
