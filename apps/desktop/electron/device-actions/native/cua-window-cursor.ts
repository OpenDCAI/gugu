import type { CuaToolResult } from './cua-client'

export interface WindowCursor { x: number; y: number; revision: string; click: boolean }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Sample on both sides of capture. A cursor that moved or changed gesture
 * during the capture cannot truthfully be attached to those pixels. */
export function cursorOnWindow(before: CuaToolResult | null, after: CuaToolResult | null, shot: CuaToolResult): WindowCursor | null {
  if (before?.isError || after?.isError) return null
  const a = before?.structuredContent
  const b = after?.structuredContent
  const first = a?.position
  const last = b?.position
  const bounds = shot.structuredContent?.window_bounds
  const width = shot.structuredContent?.screenshot_width
  const height = shot.structuredContent?.screenshot_height
  if (a?.enabled !== true || b?.enabled !== true || a.session !== b.session || !record(first) || !record(last)
    || !number(first.x) || !number(first.y) || first.x !== last.x || first.y !== last.y
    || !record(bounds) || !number(bounds.x) || !number(bounds.y) || !number(bounds.width) || !number(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0 || !number(width) || !number(height)) return null
  const x = (first.x - bounds.x) * width / bounds.width
  const y = (first.y - bounds.y) * height / bounds.height
  if (x < 0 || y < 0 || x >= width || y >= height) return null
  const priorVisual = record(a.visual_state) ? a.visual_state : {}
  const visual = record(b.visual_state) ? b.visual_state : {}
  // A click can begin at an unchanged point while the image is being taken.
  // Compare semantic state, not the continuously advancing animation frame.
  if (['requested_action', 'resolved_action', 'phase', 'preempted_count'].some(key => priorVisual[key] !== visual[key])
    || JSON.stringify(priorVisual.modifiers) !== JSON.stringify(visual.modifiers)) return null
  return { x, y, revision: `${String(b.session)}:${first.x}:${first.y}:${String(visual.requested_action)}:${String(visual.preempted_count)}`, click: /click/.test(String(visual.requested_action)) }
}
