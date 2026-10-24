import BoringAvatar from 'boring-avatars'

// The palette shown by boringavatars.com, shared by the live SVG and image-only projections.
const COLORS = ['#00686c', '#32c2b9', '#edecb3', '#fad928', '#ff9915']

export function BoringAgentAvatar({ id, name, size }: { id: string; name: string; size: number }) {
  if (!id.trim()) throw new Error('[Avatar] a Boring avatar requires a stable agent id')
  return (
    <BoringAvatar
      name={id}
      variant="beam"
      colors={COLORS}
      size={size}
      aria-label={name}
      data-agent-avatar-boring={id}
      className="block shrink-0"
    />
  )
}
