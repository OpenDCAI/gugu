import { useEffect, useRef } from 'react'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { scheduleComposerFocus } from '../../lib/focusComposer'
import { useChatStore } from '../../store/chatContext'
import { APP_COMPOSE_EVENT, type AppComposeDetail } from '../../session/shared/extensions/app-runtime-protocol'

/**
 * An App took the person to this slot's chat (desktop or phone) — a `gugu.dispatch` draft (the chat shell put the text after the
 * chat's draft, MainLayout): the slot
 * gets out from over the chat, so what the App pointed at is seen. After a compose the composer is focused — the chat's
 * own or a topic pane's. Nothing here sends.
 */
export function useSlotMakesWay(
  slot: { chatId: string; full?: boolean; onToggleFull?: () => void; onClose: () => void },
  mobile: boolean,
): void {
  const { activeChatId } = useChatStore('activeChatId')
  const latest = useRef({ slot, mobile, activeChatId })
  latest.current = { slot, mobile, activeChatId }
  const { chatId } = slot
  useEffect(() => {
    const makeWay = () => {
      const { slot: now, mobile: phone } = latest.current
      // As the header's full-width switch: a slot with a side form goes there; one covering the chat closes.
      if (now.onToggleFull && !phone) {
        if (now.full) now.onToggleFull()
      } else {
        now.onClose()
      }
    }
    const onCompose = (event: Event) => {
      if ((event as CustomEvent<AppComposeDetail>).detail?.chatId !== chatId) return
      makeWay()
      const aside = `[data-testid="${AUTOMATION_TEST_IDS.chatComposerAside}"]`
      scheduleComposerFocus('quote-attached', chatId === latest.current.activeChatId ? {} : { target: () => document.querySelector<HTMLTextAreaElement>(aside) })
    }
    window.addEventListener(APP_COMPOSE_EVENT, onCompose)
    return () => {
      window.removeEventListener(APP_COMPOSE_EVENT, onCompose)
    }
  }, [chatId])
}
