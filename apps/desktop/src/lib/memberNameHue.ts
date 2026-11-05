import { BODY_COLORS } from '../components/agentAvatar/engine/identity'
import { isBuiltinAgentAvatarUrl, resolveAgentLook, type AgentLook } from '../components/agentAvatar/look'
import { avatarColorNameHue, boringAvatarNameHue } from './agentAvatarPalette'
import { dicebearAvatarMainColor } from './dicebearAvatar'

/** Follow each generated avatar's existing main colour; uploaded images keep their identity hue. */
export function memberNameHue({ id, avatar, isAgent, assistantLook }: {
  id: string | null
  avatar?: string | null
  isAgent: boolean
  assistantLook?: AgentLook
}): number {
  const identityHue = BODY_COLORS[resolveAgentLook(id, avatar).color].hue
  if (!isAgent) {
    if (!id?.trim() || avatar != null) return identityHue
    return avatarColorNameHue(dicebearAvatarMainColor(id), identityHue)
  }
  if (!id?.trim() || (avatar != null && !isBuiltinAgentAvatarUrl(avatar))) return identityHue
  return assistantLook ? BODY_COLORS[assistantLook.color].hue : boringAvatarNameHue(id, identityHue)
}
