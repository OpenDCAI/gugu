import { useCallback, useState } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { MemberListPanel, type MemberListPanelProps } from '../../apps/desktop/src/components/chat/MemberListPanel'
import { chatService, GroupCollabEmptyError } from '../../apps/desktop/src/lib/chat'
import { ChatStoreProvider, useChatStore } from '../../apps/desktop/src/store/chatContext'
import type { DisplayIdentity } from '../../apps/desktop/src/lib/displayIdentity'

/** A conversation fixture supplies the controlled drawer's snapshot and refresh callback. */
export function MemberListPanelFixture(props: Omit<MemberListPanelProps, 'snapshot' | 'error' | 'onReload'>) {
  const chat = useChatStore()
  const [snapshot, setSnapshot] = useState<GroupCollabSnapshot | null>(null)
  const [identities, setIdentities] = useState<Record<string, DisplayIdentity>>({})
  const [error, setError] = useState<MemberListPanelProps['error']>(null)
  const reload = useCallback(async () => {
    try {
      const loaded = await chatService.getGroupCollab(props.chatId)
      setSnapshot(loaded.snapshot)
      setIdentities(Object.fromEntries(loaded.identities.map((identity) => [identity.id, identity])))
      setError(null)
    } catch (failure) {
      setError(failure instanceof GroupCollabEmptyError ? 'not-participant' : 'failed')
    }
  }, [props.chatId])
  return <ChatStoreProvider value={{ ...chat, identitiesById: { ...chat.identitiesById, ...identities } }}><MemberListPanel {...props} snapshot={snapshot} error={error} onReload={reload} /></ChatStoreProvider>
}
