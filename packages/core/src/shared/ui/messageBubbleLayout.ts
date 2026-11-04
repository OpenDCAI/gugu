/** Shared geometry of a message row and its bubble; App checks use the same phone slot as the chat. */
export const MESSAGE_BUBBLE_LAYOUT = {
  rowPadX: 14, avatarGap: 11,
  column: { phone: 0.78, desktop: 0.70 },
  bubblePadX: { phone: 16, desktop: 12 },
} as const

export const PHONE_VIEWPORT_WIDTH = 412

/** The check models this phone viewport; CDP rounds its fractional iframe width down to an integer. */
export function phoneWidgetWidth(): number {
  const layout = MESSAGE_BUBBLE_LAYOUT
  const row = PHONE_VIEWPORT_WIDTH - 2 * layout.rowPadX
  // At the check's 412px phone viewport the 78% column fits beside the avatar and gap without shrinking.
  const column = row * layout.column.phone
  return Math.floor(Math.min(420, column - 2 * layout.bubblePadX.phone))
}
