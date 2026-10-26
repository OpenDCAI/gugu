import type { DispatchAsk, DispatchPicked } from '@/session/shared/extensions/app-dispatch-core'

export type DispatchAsked = DispatchAsk & { answer: (picked: DispatchPicked) => void }

let take: ((asked: DispatchAsked) => void) | null = null

/**
 * `gugu.dispatch` naming no target, on the desktop (main asks the window) and the phone (its page asks) alike: the person
 * picks whom it goes to in the shell's sheet (DispatchSheet), seeing what goes — null when they cancel or let it run out.
 * The list is the host's own: an App hears only the target picked.
 */
export function pickDispatchTarget(asked: DispatchAsk): Promise<DispatchPicked> {
  return new Promise((resolve, reject) => {
    if (!take) return reject(new Error('No window here can ask whom to hand it to'))
    take({ ...asked, answer: resolve })
  })
}

/** The sheet takes the asks while it is drawn; the returned call lets go. */
export function takeDispatchAsks(taker: (asked: DispatchAsked) => void): () => void {
  take = taker
  return () => {
    if (take === taker) take = null
  }
}
