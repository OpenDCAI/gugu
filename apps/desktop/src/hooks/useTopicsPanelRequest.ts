import { useEffect, useState } from 'react'
import { drainTopicsPanelRequest } from '../lib/topicsPanelRequest'
import { UI_EVENTS } from '../lib/uiEvents'

/** Call after the chat surface's reset effect, including same-chat mobile reopen. */
export function useTopicsPanelRequest(chatId: string | null, openNonce: number | undefined, onOpen: (tab: 'topics') => void): void {
  const [requestRevision, setRequestRevision] = useState(0)
  useEffect(() => {
    // Navigation and this notification share a render. Consuming synchronously here would
    // open the panel before the mobile reopen effect immediately closes it again.
    const notify = () => setRequestRevision((revision) => revision + 1)
    window.addEventListener(UI_EVENTS.openTopicsPanel, notify)
    return () => window.removeEventListener(UI_EVENTS.openTopicsPanel, notify)
  }, [])
  useEffect(() => {
    if (drainTopicsPanelRequest(chatId)) onOpen('topics')
  }, [chatId, openNonce, onOpen, requestRevision])
}
