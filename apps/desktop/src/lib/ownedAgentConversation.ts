import type { NativeComposerDraft } from './nativeComposerHandoff'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'
import type { SessionpageAgentContext } from './sessionpageAgentProjection'
import { useSyncExternalStore } from 'react'

const ENTRY = '__GUGU_OWNED_AGENT_ENTRY__'
const CHANGED = 'gugu:owned-agent-entries'
type Entry = { open(chatId: string, peerId?: string, draft?: string | NativeComposerDraft): boolean; owns(peerId: string): boolean }
export function installOwnedAgentEntry(entry: Entry): () => void {
  const host = window as unknown as Record<string, unknown>
  host[ENTRY] = entry
  window.dispatchEvent(new Event(CHANGED))
  return () => { if (host[ENTRY] === entry) { delete host[ENTRY]; window.dispatchEvent(new Event(CHANGED)) } }
}
function entry(): Entry | undefined { return typeof window === 'undefined' ? undefined : (window as unknown as Record<string, Entry>)[ENTRY] }
export function openOwnedAgentEntry(chatId: string, peerId?: string, draft?: string | NativeComposerDraft): boolean { return entry()?.open(chatId, peerId, draft) ?? false }
export function isOwnedAgentPeer(peerId: string | null | undefined): boolean { return Boolean(peerId && entry()?.owns(peerId)) }
export function useOwnedAgentEntries(): void {
  useSyncExternalStore(listener => { window.addEventListener(CHANGED, listener); return () => window.removeEventListener(CHANGED, listener) }, entry, () => undefined)
}

export function isOwnedAgent(contact: Pick<ContactUser, 'type' | 'owner_user_id'> | undefined, ownerId: string): boolean {
  return contact?.type === 'agent' && contact.owner_user_id === ownerId
}

/** All personal entry points name the existing session, never a second chat workspace. */
export async function ownedAgentConversation(agentId: string, deps: {
  rows: readonly SessionDirectoryRow[]
  localContext: () => Promise<SessionpageAgentContext | null>
}): Promise<{ kind: 'local'; projectId: string; sessionId: string } | ({ kind: 'remote' } & SessionDirectoryRow)> {
  const local = await deps.localContext()
  if (local && !local.projectionError) return { kind: 'local', projectId: local.projectId, sessionId: local.sessionId }
  const rows = deps.rows.filter(row => row.session.agent?.userId === agentId)
  rows.sort((a, b) => (b.session.lastInteractedAt ?? '').localeCompare(a.session.lastInteractedAt ?? ''))
  if (rows[0]) return { kind: 'remote', ...rows[0] }
  throw new Error(local?.projectionError ?? 'Agent conversation is not in the account session directory')
}
