import { BODY_COLORS } from '../components/agentAvatar/engine/identity'
import { isBuiltinAgentAvatarUrl, resolveAgentLook, type AgentLook } from '../components/agentAvatar/look'
import { boringAvatarNameHue } from './agentAvatarPalette'

/** Follow Avatar's existing generated-body paths; uploaded images and human names keep their identity hue. */
export function memberNameHue({ id, avatar, isAgent, assistantLook }: {
  id: string | null
  avatar?: string | null
  isAgent: boolean
  assistantLook?: AgentLook
}): number {
  const identityHue = BODY_COLORS[resolveAgentLook(id, avatar).color].hue
  if (!isAgent || !id?.trim() || (avatar != null && !isBuiltinAgentAvatarUrl(avatar))) return identityHue
  return assistantLook ? BODY_COLORS[assistantLook.color].hue : boringAvatarNameHue(id, identityHue)
}
