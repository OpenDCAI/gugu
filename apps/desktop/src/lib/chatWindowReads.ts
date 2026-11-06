/**
 * @@@chat-read-before-show - a conversation nobody shows holds no message window in memory (@@@resident-windows). Whatever
 * is about to show one (the screen layout, a switch) first asks the chat store to read its window from the local store, and
 * applies the change when the read lands, so the new pane paints rows in its first frame and the old one stays until then.
 */
type ChatWindowReads = {
  /** Null: nothing to wait for (already held, or the account keeps no local store). */
  read(chatId: string): Promise<void> | null
  /** A read whose show was superseded: drop its window unless something shows the conversation by now. */
  release(chatId: string): void
}

let current: ChatWindowReads | null = null

export function provideChatWindowReads(reads: ChatWindowReads): () => void {
  current = reads
  return () => { if (current === reads) current = null }
}

export const chatWindowReads: ChatWindowReads = {
  read: (chatId) => current?.read(chatId) ?? null,
  release: (chatId) => current?.release(chatId),
}
