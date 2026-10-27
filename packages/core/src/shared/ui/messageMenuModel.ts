export interface MessageMenuCapabilities {
  hasHoverBar: boolean
}

/** Keep reactions in the menu only when the platform has no hover entry point. */
export function messageMenuModel({ hasHoverBar }: MessageMenuCapabilities) {
  return { showReactions: !hasHoverBar }
}
