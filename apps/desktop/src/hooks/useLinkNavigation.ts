import { parseConversationLink } from '@gugu/core/shared/ui/guguLink'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { OPEN_LINK_TARGET, type LinkNavigation } from '../lib/guguLinks'
import type { GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import { readMobileShell } from './useMobileShell'
import { SERVER_LOGIN_APPROVE_EVENT } from '../lib/inAppLinks'
import { readAssistantShellBridge } from '../lib/assistantShellBridge'
import { OPEN_ASSISTANT_TASK_CHAT, readAssistantTaskChat, type AssistantTaskChat } from '../lib/assistantTaskChat'
import { UI_EVENTS } from '../lib/uiEvents'
import { chatService } from '../lib/chat'
import { askReveal } from './useSourceMessageReveal'

/** The navigation belongs to the chat shell, not a Markdown renderer or an agent. */
export function useLinkNavigation(input: {
  ownerId: string
  chats: readonly ChatItem[]
  contacts: readonly ContactUser[]
  openChat: (chatId: string) => string | void
  openFile: (chatId: string, target: Extract<GuguLinkTarget, { kind: 'file' }>, source: Pick<LinkNavigation, 'message' | 'restore'>) => void
  openApp: (chatId: string, extensionId: string, tab: string) => void
  openProject: (projectId: string) => void
  openOwnApp: (extensionId: string, tab: string) => void
  openAssistant: (tasks: boolean) => string | void
}) {
  const current = useRef(input)
  current.current = input
  const { t } = useTranslation('assistant')
  const messages = useRef({ t })
  messages.current = { t }
  useEffect(() => {
    let generation = 0
    const open = async (request: LinkNavigation) => {
      const { target } = request
      const asked = generation
      const state = current.current
      if (target.kind === 'file') {
        const { localFileRevision } = await import('../lib/fileAccess')
        const local = await localFileRevision(target.itemId)
        let groupId = local?.chat_id
        if (!local) {
          const { chatDb } = await import('../lib/supabase')
          const { data, error } = await chatDb.from('workspace_items').select('chat_id').eq('id', target.itemId).maybeSingle()
          if (error) throw new Error(error.message)
          groupId = data?.chat_id
        }
        if (asked !== generation || current.current.ownerId !== state.ownerId) return
        const fileChat = state.chats.find((row) => row.id === groupId)
        if (!fileChat) throw new Error('File reference is unavailable')
        const chatId = fileChat.kind === 'topic' ? fileChat.source_chat_id! : fileChat.id
        state.openFile(chatId, target, request)
        window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
        return
      }
      if (target.kind === 'app' && !target.place) { state.openOwnApp(target.extensionId, target.tab); return 'own' as const }
      if (target.kind === 'app' && target.place && 'chat' in target.place) {
        const chatId = target.place.chat
        if (!state.chats.some((row) => row.id === chatId)) throw new Error('App chat is unavailable')
        state.openApp(chatId, target.extensionId, target.tab)
        window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
        return { chat: chatId }
      }
      if (target.kind === 'app-detail') {
        const { openAppDetailLink } = await import('../session/renderer/features/apps/app-detail-link')
        await openAppDetailLink(target, state.ownerId)
        return
      }
      if (target.kind === 'session') {
        const [{ listedSession, liveDeviceSessions }, { readCachedDevices }, { APP_SHOW_SESSION_EVENT }] = await Promise.all([
          import('../session/shared/remote-sessions/session-directory'), import('../store/devicesCache'), import('../session/shared/extensions/app-runtime-protocol'),
        ])
        const listed = listedSession(readCachedDevices(), liveDeviceSessions(), target.sessionId)
        if (!('row' in listed)) throw new Error(`Session ${target.sessionId} is not in your task list`)
        window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: listed.row }))
        return
      }
      if (target.kind === 'project') {
        if (!readMobileShell()) state.openProject(target.projectId)
        else {
          const [{ deviceSessionsOf, liveDeviceSessions }, { readCachedDevices }, { APP_SHOW_SESSION_EVENT }] = await Promise.all([
            import('../session/shared/remote-sessions/session-directory'), import('../store/devicesCache'), import('../session/shared/extensions/app-runtime-protocol'),
          ])
          if (!readCachedDevices().some((device) => deviceSessionsOf(device, liveDeviceSessions()).projects.some((project) => project.id === target.projectId))) throw new Error('Project is not in your task list')
          window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { projectId: target.projectId } }))
        }
        return
      }
      if (target.kind === 'server-login') {
        if (window.dispatchEvent(new CustomEvent(SERVER_LOGIN_APPROVE_EVENT, { detail: { code: target.code }, cancelable: true }))) throw new Error('No login approval page in this shell')
        return
      }
      if (target.kind !== 'chat') throw new Error('This target is not available in the chat shell')
      const chat = state.chats.find((row) => row.id === target.chatId)
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
      const request = (event as CustomEvent<LinkNavigation>).detail
      if (!request) return
      event.preventDefault()
      ++generation
      const asked = generation
      const owner = current.current.ownerId
      void open(request).then(request.resolve, (error: unknown) => {
        if (asked !== generation || owner !== current.current.ownerId) { request.resolve(); return }
        request.reject(targetError(request.target, error, messages.current.t('links.unavailable')))
      })
    }
    const receiveTask = () => { generation++; current.current.openAssistant(true) }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask)
    window.addEventListener(OPEN_LINK_TARGET, receive)
    return () => { generation++; window.removeEventListener(OPEN_LINK_TARGET, receive); window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask) }
  }, [])
}

function targetError(target: GuguLinkTarget, error: unknown, fallback: string) {
  return new Error(target.kind === 'app-detail' && error instanceof Error ? error.message : fallback, { cause: error })
}
