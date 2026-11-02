/** Shared geometry of a message row and its bubble; App checks use the same phone slot as the chat. */
export const MESSAGE_BUBBLE_LAYOUT = {
  rowPadX: 14, avatarGap: 11,
  column: { phone: 0.78, desktop: 0.70 },
  avatar: { phone: 44, desktop: 32 },
  bubblePadX: { phone: 16, desktop: 12 },
} as const

/** CDP viewports use integer pixels; the real iframe may have a fractional CSS width. */
export function phoneWidgetWidth(viewportWidth: number): number {
  const layout = MESSAGE_BUBBLE_LAYOUT
  const row = viewportWidth - 2 * layout.rowPadX
  const column = Math.min(row * layout.column.phone, row - layout.avatar.phone - layout.avatarGap)
  return Math.floor(Math.min(420, column - 2 * layout.bubblePadX.phone))
}
