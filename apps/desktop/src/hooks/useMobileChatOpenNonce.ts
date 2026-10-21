import { useState } from 'react'

/** Publish a mobile chat entry in the same render as the navigation, before child effects run. */
export function useMobileChatOpenNonce(mobile: boolean, pane: 'list' | 'chat'): number {
  const [entry, setEntry] = useState({ mobile, pane, nonce: 0 })
  if (entry.mobile !== mobile || entry.pane !== pane) {
    setEntry({ mobile, pane, nonce: entry.nonce + (mobile && pane === 'chat' ? 1 : 0) })
  }
  return entry.nonce
}
