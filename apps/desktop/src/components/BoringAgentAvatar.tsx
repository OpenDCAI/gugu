import BoringAvatar from 'boring-avatars'
import { boringFace } from '../lib/agentAvatarPalette'

/** `avatar` is the agent's stored address: an owner's pick (parseBoringLook) changes the face, anything else keeps the default. */
export function BoringAgentAvatar({ id, name, size, avatar }: { id: string; name: string; size: number; avatar?: string | null }) {
  if (!id.trim()) throw new Error('[Avatar] a Boring avatar requires a stable agent id')
  const face = boringFace(id, avatar)
  return (
    <BoringAvatar
      name={face.seed}
      variant="beam"
      colors={face.colors}
      size={size}
      aria-label={name}
      data-agent-avatar-boring={id}
      className="block shrink-0"
    />
  )
}
