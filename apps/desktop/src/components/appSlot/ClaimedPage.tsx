import { observer } from 'mobx-react-lite'
import { useContext, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { extensionViewStore } from '../../session/renderer/features/extensions/extension-view-store'
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
export const ClaimedPage = observer(function ClaimedPage({ slotId, chatId, kind, itemId }: { slotId: string; chatId: string; kind: string; itemId?: string }) {
  const { t } = useTranslation('messaging')
  const boxRef = useRef<HTMLDivElement | null>(null)
  // A covered slot keeps its claim for the way back.
  const coveredRef = useRef(false)
  coveredRef.current = useContext(PeekCovered)
  // The resident layer draws a page only for an App it keeps (installed, switched on, listed in this window:
  // `residentTabContributions`): with none, the slot says so instead of staying blank (L4 09-29).
  const noPage = installedExtensionsStore.isLoaded && !installedExtensionsStore.residentTabContributions.some((entry) => entry.kind === kind)
  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    // The same store the session page's slots claim (one module, two React roots): the root layer draws the page here.
    let token: number | null = null
    const visible = () => {
      if (!element.isConnected || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false
      const box = element.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }
    const sync = () => {
      const want = visible()
      if (want === (token !== null) || (!want && coveredRef.current)) return
      if (want) token = extensionViewStore.claim(kind, { tabId: slotId, chatId, element, ...(itemId ? { itemId } : {}) })
      else if (token !== null) {
        extensionViewStore.release(kind, token)
        token = null
      }
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
      if (token !== null) extensionViewStore.release(kind, token)
    }
  }, [chatId, kind, itemId, slotId])
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
