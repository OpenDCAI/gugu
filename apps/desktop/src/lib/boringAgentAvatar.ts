import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoringAgentAvatar } from '../components/BoringAgentAvatar'

/** Image-only consumers use the same official SVG component; no rasterization or remote service. */
export function boringAgentAvatarDataUri(id: string, avatar?: string | null): string {
  const svg = renderToStaticMarkup(createElement(BoringAgentAvatar, { id, name: id, size: 256, avatar }))
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
