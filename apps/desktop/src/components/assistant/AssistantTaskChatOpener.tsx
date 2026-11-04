import { messageForUser } from '@/lib/userFacingError';
import { useEffect,useRef, useState, useSyncExternalStore } from 'react'
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
import {AssistantWorkTaskWindow} from './AssistantWorkTaskWindow'
import { readRequiredDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('assistant/task-chat-open')

export function AssistantTaskChatOpener({ visible }: { visible: boolean }) {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const { toast } = useToast()
  const { t } = useTranslation('assistant')
  const opened = useOpenedAssistantTaskChat()
  const [resolved, setResolved] = useState<{ ownerId: string; agent: ContactUser } | null>(null)
  const shellSlots = readShellSlots()
  const slot = useSyncExternalStore((listener) => shellSlots?.subscribeSlots(listener) ?? (() => undefined), () => shellSlots?.getSlots().get(assistantSlotKey('task-chat')) ?? null)
  const wasVisible=useRef(visible)
  useEffect(() => {
    const left=wasVisible.current&&!visible
    wasVisible.current=visible
    if(left||opened&&opened.ownerId!==user?.id)showAssistantTaskChat(null)
  }, [visible, user?.id, opened])
  useEffect(() => {
    let alive = true
    let pending: string | null = null
    let generation = 0
    const open = (event: Event) => {
      const request = (event as CustomEvent<AssistantTaskChat>).detail
      if (!user || pending === `${request.taskAgentId}:${request.workId ?? "legacy"}`) return
      const current = ++generation
      if(request.workId){
        showAssistantTaskChat({ownerId:user.id,request,name:request.title??t('tasks.title')})
        return
      }
      const show = (identities: readonly ContactUser[]) => {
        const owned = (id: string) => identities.find(contact => contact.id === id && contact.type === 'agent' && contact.owner_user_id === user.id)
        const task = request.taskAgentId?owned(request.taskAgentId):undefined
        if (!task || !owned(request.assistantId)) throw new Error('Task identity is not owned by the signed-in account')
        setResolved({ ownerId: user.id, agent: task })
        rememberAssistantTaskChat(user.id, request)
        showAssistantTaskChat({ ownerId: user.id, request, name: task.display_name })
      }
      const missing = [request.taskAgentId, request.assistantId].filter((id):id is string => !!id&&!contacts.some(contact => contact.id === id))
      if (missing.length === 0) {
        try { show(contacts) } catch (error) { log.error({ error: error }, 'action failed'); toast(t('tasks.chatUnavailable'), 'error', messageForUser(error)) }
        return
      }
      // A newly created agent reaches the session directory before the contacts snapshot.
      // Read its canonical identity, rather than treating a stale cache as a failed creation.
      pending = `${request.taskAgentId}:${request.workId ?? "legacy"}`
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
  if(!visible||!slot)return null
  if(opened?.request.workId&&user?.id===opened.ownerId)return createPortal(<AssistantWorkTaskWindow ownerId={user.id} request={opened.request}/>,slot)
  if (!agent || !opened) return null
  const close = () => showAssistantTaskChat(null)
  return createPortal(<AssistantTaskChatWindow agent={agent} task={opened.request.task} onClose={close} />, slot)
}
