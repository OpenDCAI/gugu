import BoringAvatar from 'boring-avatars'
import { agentAvatarPalette } from '../lib/agentAvatarPalette'

export function BoringAgentAvatar({ id, name, size }: { id: string; name: string; size: number }) {
  if (!id.trim()) throw new Error('[Avatar] a Boring avatar requires a stable agent id')
  return (
    <BoringAvatar
      name={id}
      variant="beam"
      colors={agentAvatarPalette(id)}
      size={size}
      aria-label={name}
      data-agent-avatar-boring={id}
      className="block shrink-0"
    />
  )
}
