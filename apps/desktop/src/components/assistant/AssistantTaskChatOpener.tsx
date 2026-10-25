import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { createPortal } from 'react-dom'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { useToast } from '../toastContext'
import { useTranslation } from 'react-i18next'
import { OPEN_ASSISTANT_TASK_CHAT, rememberAssistantTaskChat, showAssistantTaskChat, useOpenedAssistantTaskChat, type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantSlotKey } from '../../lib/assistantShellBridge'
import { readShellSlots } from '../../lib/shellSlots'
import { AssistantTaskChatWindow } from './AssistantTaskChatWindow'
import type { AssistantChatHandlers } from './AssistantChatSlot'
import { readRequiredDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('assistant/task-chat-open')

export function AssistantTaskChatOpener({ visible, ...handlers }: { visible: boolean } & AssistantChatHandlers) {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const { toast } = useToast()
  const { t } = useTranslation('assistant')
  const opened = useOpenedAssistantTaskChat()
  const [resolved, setResolved] = useState<{ ownerId: string; agent: ContactUser } | null>(null)
  const shellSlots = readShellSlots()
  const slot = useSyncExternalStore((listener) => shellSlots?.subscribeSlots(listener) ?? (() => undefined), () => shellSlots?.getSlots().get(assistantSlotKey('task-chat')) ?? null)
  useEffect(() => { if (!visible || opened && opened.ownerId !== user?.id) showAssistantTaskChat(null) }, [visible, user?.id, opened])
  useEffect(() => {
    let alive = true
    let pending: string | null = null
    let generation = 0
    const open = (event: Event) => {
      const request = (event as CustomEvent<AssistantTaskChat>).detail
      if (!user || pending === request.taskAgentId) return
      const current = ++generation
      const show = (identities: readonly ContactUser[]) => {
        const owned = (id: string) => identities.find(contact => contact.id === id && contact.type === 'agent' && contact.owner_user_id === user.id)
        const task = owned(request.taskAgentId)
        if (!task || !owned(request.assistantId)) throw new Error('Task identity is not owned by the signed-in account')
        setResolved({ ownerId: user.id, agent: task })
        rememberAssistantTaskChat(user.id, request)
        showAssistantTaskChat({ ownerId: user.id, request, name: task.display_name })
      }
      const missing = [request.taskAgentId, request.assistantId].filter(id => !contacts.some(contact => contact.id === id))
      if (missing.length === 0) {
        try { show(contacts) } catch (error) { log.error({ error: error }, 'action failed'); toast(t('tasks.chatUnavailable'), 'error', messageForUser(error)) }
        return
      }
      // A newly created agent reaches the session directory before the contacts snapshot.
      // Read its canonical identity, rather than treating a stale cache as a failed creation.
      pending = request.taskAgentId
      void readRequiredDisplayIdentities(missing).then(identities => {
        if (alive && current === generation) show([...contacts, ...identities])
      }).catch((error: unknown) => {
        log.error({ error, taskAgentId: request.taskAgentId }, 'task identity read failed')
        if (alive && current === generation) toast(t('tasks.chatUnavailable'), 'error', messageForUser(error))
      }).finally(() => { if (current === generation) pending = null })
    }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, open)
    return () => { alive = false; window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, open) }
  }, [contacts, t, toast, user])
  const agent = opened && user && opened.ownerId === user.id ? contacts.find((contact) => contact.id === opened.request.taskAgentId)
    ?? (resolved && resolved.ownerId === user.id && resolved.agent.id === opened.request.taskAgentId ? resolved.agent : null) : null
  if (!visible || !agent || !slot) return null
  const close = () => showAssistantTaskChat(null)
  return createPortal(<AssistantTaskChatWindow agent={agent} onClose={close}
    onOpenUserChat={handlers.onOpenUserChat ? (target) => { close(); handlers.onOpenUserChat?.(target) } : undefined}
    onOpenSessionpageAgent={handlers.onOpenSessionpageAgent ? (id, view) => { close(); return handlers.onOpenSessionpageAgent!(id, view) } : undefined}
    onOpenSessionpageAgentFile={handlers.onOpenSessionpageAgentFile ? (id, path) => { close(); return handlers.onOpenSessionpageAgentFile!(id, path) } : undefined} />, slot)
}
