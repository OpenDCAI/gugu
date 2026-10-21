import { observer } from 'mobx-react-lite'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { peekStore } from '../../session/renderer/features/extensions/peek-store'
import { useBackLayer } from '../ui/sheetStack'
import { PeekCovered } from './peekCovered'

// What is drawn in it, loaded when something is opened (it reaches the host's previews, frames and platform).
const AppPeek = lazy(() => import('./AppPeek').then((m) => ({ default: m.AppPeek })))

/** Wide enough for the page and what is opened beside it, side by side; narrower, it opens over the page. */
const BESIDE_MIN_WIDTH = 960

/**
 * G1 One App page's slot, and what is opened beside that page (`peekStore`, by the slot the page is drawn in). Wide, the
 * two sit side by side; narrow (a chat's panel, a phone), it opens over the page, with a way back. The page itself is never
 * moved, unmounted or given up — only hidden while covered — so it is just as it was when what was opened closes.
 */
export const AppPeekSlot = observer(function AppPeekSlot({ sessionId, tabId, narrow = false, children }: { sessionId: string | null; tabId: string; narrow?: boolean; children: ReactNode }) {
  const target = peekStore.of(sessionId, tabId)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // Measured only while something is open beside the page: a slot with nothing open costs nothing.
  const open = target !== null
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !open) return undefined
    const observer = new ResizeObserver(() => setWidth(box.getBoundingClientRect().width))
    observer.observe(box)
    return () => observer.disconnect()
  }, [open])
  const close = () => peekStore.close(sessionId, tabId)
  // The phone's back key (and the header's back) closes it before anything under it.
  useBackLayer(close, target !== null)
  const beside = !narrow && width >= BESIDE_MIN_WIDTH
  const covered = target !== null && !beside
  return (
    // Narrow (a phone), what is opened covers the panel's header too — the slot is not its containing block, the panel is:
    // one header on screen, the peek's, whose back returns to the page with its own.
    <div ref={boxRef} className={`${narrow ? '' : 'relative '}flex min-h-0 min-w-0 flex-1`} data-testid="app-peek-slot" data-peek={target ? (beside ? 'beside' : 'over') : undefined}>
      {/* Same element whether or not something is open: the page in it must never be remounted. */}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col${covered ? ' invisible' : ''}`}>
        <PeekCovered.Provider value={covered}>{children}</PeekCovered.Provider>
      </div>
      {target ? (
        <div
          className={beside ? 'flex min-h-0 w-[max(420px,45%)] shrink-0 flex-col border-l border-[var(--border)]' : 'absolute inset-0 flex flex-col bg-[var(--bg-primary)]'}
          data-testid="app-peek"
          data-peek-kind={target.kind}
        >
          <Suspense fallback={null}>
            <AppPeek target={target} slotKey={`${sessionId ?? ''}:${tabId}`} beside={beside} onClose={close} />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
})
