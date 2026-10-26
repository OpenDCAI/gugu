import { useEffect, useRef } from 'react'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { scheduleComposerFocus } from '../../lib/focusComposer'
import { useChatStore } from '../../store/chatContext'
import { APP_COMPOSE_EVENT, type AppComposeDetail } from '../../session/shared/extensions/app-runtime-protocol'

/**
 * An App took the person to this tab's chat (desktop or phone) — a `gugu.dispatch` draft (the chat shell put the text
 * after the chat's draft, MainLayout): the tab gets out from over the chat (`makeWay`), so what the App pointed at is
 * seen. After a compose the composer is focused — the chat's own or a topic pane's. Nothing here sends.
 */
export function useSlotMakesWay(chatId: string, makeWay: () => void): void {
  const { activeChatId } = useChatStore('activeChatId')
  const latest = useRef({ makeWay, activeChatId })
  latest.current = { makeWay, activeChatId }
  useEffect(() => {
    const onCompose = (event: Event) => {
      if ((event as CustomEvent<AppComposeDetail>).detail?.chatId !== chatId) return
      latest.current.makeWay()
      const aside = `[data-testid="${AUTOMATION_TEST_IDS.chatComposerAside}"]`
      scheduleComposerFocus('quote-attached', chatId === latest.current.activeChatId ? {} : { target: () => document.querySelector<HTMLTextAreaElement>(aside) })
    }
    window.addEventListener(APP_COMPOSE_EVENT, onCompose)
    return () => {
      window.removeEventListener(APP_COMPOSE_EVENT, onCompose)
    }
  }, [chatId])
}
