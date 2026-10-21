/** Resolve a message to the data index expected by FlowListHandle.scrollToIndex (lib/flowList.ts).
 * Missing messages stay explicit so callers cannot silently scroll elsewhere.
 */
export interface ScrollableRow {
  type: string
  message?: { id: string }
}

export function resolveSourceMessageScroll(
  rows: ReadonlyArray<ScrollableRow>,
  messageId: string,
): number | null {
  const dataIndex = rows.findIndex((r) => r.type === 'message' && r.message?.id === messageId)
  return dataIndex < 0 ? null : dataIndex
}
