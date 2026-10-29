import { useId } from 'react'
import { BORING_MASK_FILL, boringFace, boringFaceFeatureColor } from '../lib/agentAvatarPalette'

// Boring avatars' beam variant (MIT, boringdesigners/boring-avatars 2.0.4; see THIRD_PARTY_NOTICES.md), ported so the
// face can take its own colour: geometry and hashing are unchanged, so every agent keeps its shape and palette.
const SIZE = 36
function hashCode(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  return Math.abs(hash)
}
const digit = (n: number, place: number) => Math.floor((n / 10 ** place) % 10)
const unit = (n: number, range: number, place?: number) => (place && digit(n, place) % 2 === 0 ? -(n % range) : n % range)

/** `avatar` is the agent's stored address: an owner's pick (parseBoringLook) changes the face, anything else keeps the default. */
export function BoringAgentAvatar({ id, name, size, avatar }: { id: string; name: string; size: number; avatar?: string | null }) {
  const mask = useId()
  if (!id.trim()) throw new Error('[Avatar] a Boring avatar requires a stable agent id')
  const { seed, colors } = boringFace(id, avatar)
  const n = hashCode(seed)
  const body = colors[n % colors.length]
  const face = boringFaceFeatureColor(body)
  const x0 = unit(n, 10, 1), y0 = unit(n, 10, 2)
  const x = x0 < 5 ? x0 + SIZE / 9 : x0, y = y0 < 5 ? y0 + SIZE / 9 : y0
  const mouthSpread = unit(n, 3), eyeSpread = unit(n, 5)
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width={size} height={size}
      aria-label={name} data-agent-avatar-boring={id} className="block shrink-0">
      <mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={SIZE} height={SIZE}>
        <rect width={SIZE} height={SIZE} rx={SIZE * 2} fill={BORING_MASK_FILL} />
      </mask>
      <g mask={`url(#${mask})`}>
        <rect width={SIZE} height={SIZE} fill={colors[(n + 13) % colors.length]} />
        <rect x="0" y="0" width={SIZE} height={SIZE}
          transform={`translate(${x} ${y}) rotate(${unit(n, 360)} ${SIZE / 2} ${SIZE / 2}) scale(${1 + unit(n, SIZE / 12) / 10})`}
          fill={body} rx={!(digit(n, 1) % 2) ? SIZE : SIZE / 6} />
        <g transform={`translate(${x > SIZE / 6 ? x / 2 : unit(n, 8, 1)} ${y > SIZE / 6 ? y / 2 : unit(n, 7, 2)}) rotate(${unit(n, 10, 3)} ${SIZE / 2} ${SIZE / 2})`}>
          {!(digit(n, 2) % 2)
            ? <path d={`M15 ${19 + mouthSpread}c2 1 4 1 6 0`} stroke={face} fill="none" strokeLinecap="round" />
            : <path d={`M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0`} fill={face} />}
          <rect x={14 - eyeSpread} y={14} width={1.5} height={2} rx={1} stroke="none" fill={face} />
          <rect x={20 + eyeSpread} y={14} width={1.5} height={2} rx={1} stroke="none" fill={face} />
        </g>
      </g>
    </svg>
  )
}
