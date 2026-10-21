import { observer } from 'mobx-react-lite'
import { useContext, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { APP_SLOT_EVENT, type AppSlotEventDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { PeekCovered } from './peekCovered'

/** What in an ancestor can hide the slot without moving or resizing it (`RETAINED_SURFACE_HIDDEN_STYLE`). */
const HIDING_ATTRIBUTES = ['style', 'class', 'hidden', 'inert']

/**
 * The slot's claim on its App page — only while the slot can be seen (真源 §5-a 「看得见才认领」, 摩擦单
 * F17). The chat surface is kept but hidden when the person goes elsewhere (New Agent, another group,
 * the session page, settings): `visibility: hidden` on an ancestor, which neither moves nor resizes the
 * slot, so the page drawn over it would stay on screen, over whatever is there now. So the slot
 * watches its own box and every ancestor's hiding attributes, and claims while it is visible,
 * releases while it is not — the same for the App's own page and a page opened for a file.
 */
export const ClaimedPage = observer(function ClaimedPage({ slotId, chatId, kind, itemId, opening }: { slotId: string; chatId: string; kind: string; itemId?: string; opening?: number }) {
  const { t } = useTranslation('messaging')
  const boxRef = useRef<HTMLDivElement | null>(null)
  // A page opened for a file goes when its claim does (extension-view-store): covered, the slot keeps it for the way back.
  const coveredRef = useRef(false)
  coveredRef.current = useContext(PeekCovered)
  // The resident layer draws a page only for an App it keeps (installed, switched on, listed in this window:
  // `residentTabContributions`): with none, the slot says so instead of staying blank (L4 09-29).
  const noPage = installedExtensionsStore.isLoaded && !installedExtensionsStore.residentTabContributions.some((entry) => entry.kind === kind)
  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    const send = (detail: AppSlotEventDetail) => window.dispatchEvent(new CustomEvent(APP_SLOT_EVENT, { detail }))
    let claimed = false
    const visible = () => {
      if (!element.isConnected || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false
      const box = element.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }
    const sync = () => {
      const want = visible()
      if (want === claimed || (!want && coveredRef.current)) return
      claimed = want
      if (want) send({ type: 'claim', slotId, kind, chatId, element, ...(itemId ? { itemId } : {}) })
      else send({ type: 'release', slotId })
    }
    sync()
    const resized = new ResizeObserver(sync)
    resized.observe(element)
    const restyled = new MutationObserver(sync)
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      restyled.observe(node, { attributes: true, attributeFilter: HIDING_ATTRIBUTES })
    }
    return () => {
      resized.disconnect()
      restyled.disconnect()
      if (claimed) send({ type: 'release', slotId })
    }
    // `opening`: a new open of the same file is a new claim, so a new page (摩擦单 F28).
  }, [chatId, kind, itemId, opening, slotId])
  return (
    <div ref={boxRef} className="min-h-0 flex-1">
      {noPage ? (
        <p className="!p-4 text-[length:var(--font-body)] text-[var(--text-secondary)]" data-testid="group-app-slot-no-page">
          {t('chatArea.openWith.unavailable')}
        </p>
      ) : null}
    </div>
  )
})
