import { AlertTriangle } from '@/lib/icons'

/**
 * The needs-you marker (base status `needs_user`) is a shape, not another status color. Solar's
 * AlertTriangle includes the exclamation glyph and remains distinguishable
 * from the dot-based states at the smallest desktop status surfaces.
 */
export function AgentNeedsUserGlyph({
  size = 8,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <AlertTriangle
      aria-hidden="true"
      data-agent-status-glyph="needs_user"
      size={size}
      className={`text-[var(--agent-tone-needs-user)] shrink-0 ${className ?? ''}`.trim()}
    />
  )
}
