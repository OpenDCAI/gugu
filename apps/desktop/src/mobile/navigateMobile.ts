import { flushSync } from 'react-dom'

let running: ViewTransition | undefined

/** Drop stale page snapshots; their queued update callbacks still need intent guards. */
export function skipMobileTransition() {
  running?.skipTransition()
}

/** Animate the existing page; content commits without waiting for data or the animation. */
export function navigateMobile(update: () => void, direction: 'push' | 'pop' | 'replace') {
  if (!document.startViewTransition || !document.querySelector('[data-mobile-tab-pager]')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update()
    return
  }
  skipMobileTransition()
  document.documentElement.dataset.mobileDirection = direction
  const transition = document.startViewTransition(() => flushSync(update))
  running = transition
  void transition.finished.finally(() => {
    if (running !== transition) return
    running = undefined
    delete document.documentElement.dataset.mobileDirection
  })
}
