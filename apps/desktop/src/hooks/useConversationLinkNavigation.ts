import { parseConversationLink } from '@gugu/core/shared/ui/conversationLink'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useToast } from '../components/toastContext'
import { OPEN_CONVERSATION_LINK, type ConversationLinkRequest } from '../lib/conversationLinks'
import { readAssistantShellBridge } from '../lib/assistantShellBridge'
import { OPEN_ASSISTANT_TASK_CHAT, readAssistantTaskChat, type AssistantTaskChat } from '../lib/assistantTaskChat'
import { UI_EVENTS } from '../lib/uiEvents'
import { chatService } from '../lib/chat'
import { askReveal } from './useSourceMessageReveal'

/** The navigation belongs to the chat shell, not a Markdown renderer or an agent. */
export function useConversationLinkNavigation(input: {
  ownerId: string
  chats: readonly ChatItem[]
  contacts: readonly ContactUser[]
  openChat: (chatId: string) => string | void
  openAssistant: (tasks: boolean) => string | void
}) {
  const current = useRef(input)
  current.current = input
  const { toast } = useToast()
  const { t } = useTranslation('assistant')
  const messages = useRef({ toast, t })
  messages.current = { toast, t }
  useEffect(() => {
    let generation = 0
    const open = async (target: ConversationLinkRequest['target']) => {
      const asked = generation
      const state = current.current
      const chat = target && state.chats.find((row) => row.id === target.chatId)
      if (!target || !chat) throw new Error('Conversation reference is unavailable')
      if (target.messageId) {
        const message = await chatService.getMessageById(target.messageId, state.ownerId)
        if (!message || message.chat_id !== chat.id || message.retracted_at) throw new Error('Message reference is unavailable')
      }
      if (asked !== generation || current.current.ownerId !== state.ownerId) return
      const assistant = readAssistantShellBridge()?.getSnapshot()
      let task: AssistantTaskChat | null = null
      const contact = state.contacts.find((row) => row.id === chat.peer_user_id)
      if (assistant?.assistant && contact?.type === 'agent' && contact.owner_user_id === state.ownerId
        && contact.id !== assistant.assistant.id) {
        task = readAssistantTaskChat(state.ownerId, contact.id)
        if (!task) {
          const [{ remoteHostsStore }, { rpcOn }, { readCachedDevices }, { assistantDescendants }] = await Promise.all([
            import('../session/renderer/features/remote-hosts/remote-hosts-store'),
            import('../session/renderer/lib/ipc'), import('../store/devicesCache'),
            import('../session/renderer/features/assistant/assistant-lineage'),
          ])
          const local = readCachedDevices().find((device) => device.is_current_device)
          const listed = [...remoteHostsStore.allListedSessions()]
          if (local) {
            const sessions = await rpcOn(null).sessionTimeline.sessionsList()
            listed.push(...sessions.sessions.map((summary) => ({ deviceId: local.device_id, summary, live: true })))
          }
          const descendants = assistantDescendants(listed, assistant.assistant.id)
          const child = listed.find((row) => row.summary.agent?.userId === contact.id && (descendants.includes(row) || row.summary.activitySourceLinks?.some((href) => parseConversationLink(href)?.chatId === assistant.chatId)))
          if (child) task = {
            assistantId: assistant.assistant.id, taskAgentId: contact.id,
            task: { deviceId: child.deviceId, sessionId: child.summary.conversationId },
            assistants: listed.filter((row) => row.summary.agent?.userId === assistant.assistant!.id)
              .map((row) => ({ deviceId: row.deviceId, sessionId: row.summary.conversationId })),
          }
        }
      }
      if (asked !== generation || current.current.ownerId !== state.ownerId) return
      let viewportKey: string | void
      if (chat.id === assistant?.chatId) viewportKey = state.openAssistant(false)
      else if (task) {
        viewportKey = state.openAssistant(true)
        window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT, { detail: task }))
      } else viewportKey = state.openChat(chat.id)
      if (target.messageId) askReveal(chat.id, target.messageId, viewportKey || undefined)
      window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: chat.id } }))
    }
    const receive = (event: Event) => {
      const asked = ++generation
      const owner = current.current.ownerId
      const target = (event as CustomEvent<ConversationLinkRequest>).detail?.target
      void open(target ?? null).catch(() => {
        if (asked === generation && owner === current.current.ownerId) messages.current.toast(messages.current.t('links.unavailable'), 'error')
      })
    }
    const receiveTask = () => { generation++; current.current.openAssistant(true) }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask)
    window.addEventListener(OPEN_CONVERSATION_LINK, receive)
    return () => { generation++; window.removeEventListener(OPEN_CONVERSATION_LINK, receive); window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask) }
  }, [])
}
