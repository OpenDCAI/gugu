/** Shared geometry of a message row and its bubble; App checks use the same phone slot as the chat. */
export const MESSAGE_BUBBLE_LAYOUT = {
  rowPadX: 14, avatarGap: 11,
  column: { phone: 0.78, desktop: 0.70 },
  bubblePadX: { phone: 16, desktop: 12 },
} as const

/** CDP viewports use integer pixels; the real iframe may have a fractional CSS width. */
export function phoneWidgetWidth(viewportWidth: number): number {
  const layout = MESSAGE_BUBBLE_LAYOUT
  const row = viewportWidth - 2 * layout.rowPadX
  // At the check's 412px phone viewport the 78% column fits beside the avatar and gap without shrinking.
  const column = row * layout.column.phone
  return Math.floor(Math.min(420, column - 2 * layout.bubblePadX.phone))
}
