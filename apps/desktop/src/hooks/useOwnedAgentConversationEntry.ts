import { readAssistantShellBridge } from '@/lib/assistantShellBridge'
import type { NativeComposerDraft } from '@/lib/nativeComposerHandoff'
import { appendToDraft, useChatStore } from '@/store/chatContext'
import { composeTaskDraft } from '@/lib/composeDraft'
import { useCallback, useEffect, useRef } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useDevicesStore } from '@/store/devicesContext'
import { directoryRows, liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import { desktopIpc } from '@/platform/desktopIpc'
import { installOwnedAgentEntry, isOwnedAgent, ownedAgentConversation } from '@/lib/ownedAgentConversation'
import { parseSessionpageAgentContext } from '@/lib/sessionpageAgentProjection'
import { openTarget } from '@/lib/guguLinks'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { readSessionpageViewRequestBridge } from '@/lib/sessionpageViewRequestBridge'
import type { GroupParticipantRequest } from '@/session/renderer/features/chats/group-participant-requests'

/** Ownership is checked before looking up a private timeline. An async open cannot cross an account switch. */
export function useOwnedAgentConversationEntry(input: {
  ownerId: string; chats: readonly ChatItem[]; contacts: readonly ContactUser[]; mobile: boolean; onOpen: () => void
}): (chatId: string | undefined, peerId?: string, draft?: string | NativeComposerDraft, sourceChatId?: string) => boolean {
  const { drafts, writeDraft, draftAttachments, setDraftAttachments, identitiesById, setActiveChatId } = useChatStore('drafts', 'writeDraft', 'draftAttachments', 'setDraftAttachments', 'identitiesById', 'setActiveChatId')
  const draftState = useRef({ drafts, writeDraft, draftAttachments, setDraftAttachments })
  draftState.current = { drafts, writeDraft, draftAttachments, setDraftAttachments }
  const { devices, phones } = useDevicesStore()
  // The account IM repository already retains canonical ownership. Cold offline
  // entry must not depend on the network-only contact relationship refresh.
  const current = useRef({ ...input, identitiesById, setActiveChatId })
  current.current = { ...input, identitiesById, setActiveChatId }
  const generation = useRef(0)
  const cancelGroupRequest = useRef<GroupParticipantRequest | undefined>(undefined)
  useEffect(() => () => { ++generation.current; cancelGroupRequest.current?.() }, [input.ownerId])
  const open = useCallback((chatId: string | undefined, peerId?: string, draft?: string | NativeComposerDraft, sourceChatId?: string) => {
    const state = current.current
    const asked = ++generation.current
    cancelGroupRequest.current?.()
    const peer = state.chats.find(chat => chat.id === chatId && (chat.kind === 'dm' || chat.kind === 'ai'))?.peer_user_id ?? peerId
    const contact = state.contacts.find(one => one.id === peer) ?? (peer ? state.identitiesById[peer] : undefined)
    if (!contact || !isOwnedAgent(contact, state.ownerId) || contact.id === readAssistantShellBridge()?.getSnapshot()?.assistant?.id) return false
    if (!sourceChatId && chatId) state.setActiveChatId(chatId)
    const old = draftState.current
    const incoming: NativeComposerDraft | undefined = typeof draft === 'string' ? { text: draft } : draft
    const text = incoming ? incoming.append ? appendToDraft(chatId ? old.drafts?.[chatId] ?? '' : '', incoming.text) : incoming.text : chatId ? old.drafts?.[chatId] ?? '' : ''
    const carried = [...(chatId ? old.draftAttachments?.[chatId] ?? [] : []), ...(incoming?.files ?? []).map(file => ({ id: crypto.randomUUID(), file, kind: file.type.startsWith('image/') ? 'image' as const : 'file' as const }))]
    if (incoming && chatId) { old.writeDraft(chatId, text); old.setDraftAttachments(chatId, carried) }
    if (!sourceChatId) state.onOpen()
    const api = desktopIpc()
    void ownedAgentConversation(contact.id, {
      rows: directoryRows([...devices, ...(phones ?? [])], liveDeviceSessions()),
      localContext: async () => api ? parseSessionpageAgentContext(await api.invoke('sessionpage:agent-context', contact.id)) : null,
    }).then(async target => {
      if (asked !== generation.current || current.current.ownerId !== state.ownerId) return
      let groupParticipantRequestId: string | undefined
      if (sourceChatId && !state.mobile) {
        const bridge = readSessionpageViewRequestBridge()
        if (!bridge?.prepareGroupSession) throw new Error('The session page is not ready to open a group participant')
        cancelGroupRequest.current = bridge.prepareGroupSession(sourceChatId, target.kind === 'local'
          ? target : { projectId: target.session.projectId, sessionId: target.session.conversationId })
        groupParticipantRequestId = cancelGroupRequest.current.requestId
      }
      const requestArgs: [] | [string] = groupParticipantRequestId ? [groupParticipantRequestId] : []
      if (text || carried.length) {
        const row = target.kind === 'remote' ? target : { session: { conversationId: target.sessionId, projectId: target.projectId } as import('@gugu/session-core/session-record/contract').SessionpageSessionSummary }
        await composeTaskDraft(row, text, state.mobile, carried.map(one => one.file), ...requestArgs)
        if (chatId && asked === generation.current && current.current.ownerId === state.ownerId) {
          const latest = draftState.current
          if (latest.drafts?.[chatId] === text) latest.writeDraft(chatId, '')
          const ids = new Set(carried.map(one => one.id))
          latest.setDraftAttachments(chatId, (latest.draftAttachments?.[chatId] ?? []).filter(one => !ids.has(one.id)))
        }
      } else if (state.mobile && target.kind === 'remote') {
        window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { deviceId: target.deviceId, session: target.session } }))
      } else {
        await openTarget(target.kind === 'local'
          ? { kind: 'session', sessionId: target.sessionId, projectId: target.projectId }
          : { kind: 'session', sessionId: target.session.conversationId, projectId: target.session.projectId, deviceId: target.deviceId }, ...requestArgs)
      }
    }).catch(error => {
      if (asked === generation.current) cancelGroupRequest.current?.()
      if (asked === generation.current && current.current.ownerId === state.ownerId) notify({ tier: 'error', title: messageForUser(error) })
    })
    return true
  }, [devices, phones])
  useEffect(() => installOwnedAgentEntry({ open, owns: id => id !== readAssistantShellBridge()?.getSnapshot()?.assistant?.id && isOwnedAgent(current.current.contacts.find(contact => contact.id === id) ?? current.current.identitiesById[id], current.current.ownerId) }), [open, input.ownerId, input.contacts, identitiesById])
  return open
}
