import type { ComposePickAsk, ComposePlace } from '@/session/shared/extensions/app-send-core'

export type ComposeAsked = ComposePickAsk & { answer: (place: ComposePlace | null) => void }

let take: ((asked: ComposeAsked) => void) | null = null

/**
 * `gugu.compose(text)` naming no place, on the desktop (main asks the window) and the phone (its page asks) alike: the person
 * picks a chat, or one of this computer's tasks, in the shell's sheet (ComposeTargetPicker) — null when they cancel or let it
 * run out. The list is the host's own: an App hears only the place picked.
 */
export function pickComposeTarget(asked: ComposePickAsk): Promise<ComposePlace | null> {
  return new Promise((resolve, reject) => {
    if (!take) return reject(new Error('No window here can ask where to compose'))
    take({ ...asked, answer: resolve })
  })
}

/** The sheet takes the asks while it is drawn; the returned call lets go. */
export function takeComposeAsks(taker: (asked: ComposeAsked) => void): () => void {
  take = taker
  return () => {
    if (take === taker) take = null
  }
}
