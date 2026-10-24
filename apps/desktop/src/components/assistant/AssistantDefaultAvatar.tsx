import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { colorSlug, type AgentLook } from '../agentAvatar/look'
import { useAgentLook } from '../agentAvatar/useAgentLook'
import { useAgentLookPoster } from '../agentAvatar/posters'

/** The assistant alone keeps the 3D figure and its still posters. */
export function AssistantDefaultAvatar({ id, avatar, look, name, size, still = false, hoverPoke, state }: {
  id: string
  avatar?: string | null
  look?: AgentLook
  name: string
  size: number
  still?: boolean
  hoverPoke?: boolean
  state?: AgentStatusLabel | null
}) {
  return still ? <AssistantStill id={id} avatar={avatar} look={look} name={name} size={size} />
    : <AgentAvatar id={id} avatar={avatar} look={look} name={name} size={size} hoverPoke={hoverPoke} state={state} />
}

function AssistantStill({ id, avatar, look, name, size }: { id: string; avatar?: string | null; look?: AgentLook; name: string; size: number }) {
  const resolved = useAgentLook(id, look, avatar)
  const poster = useAgentLookPoster(resolved)
  return <img src={poster} alt={name} aria-label={name} draggable={false} data-agent-avatar-still={colorSlug(resolved.color)}
    width={size} height={size} className="block shrink-0 object-contain" />
}
