import { useEffect, useRef } from 'react'
import type { AccountImRepository } from '../lib/imRepository'
import { readDisplayIdentities } from '../lib/identityReadAdapter'
import { refreshObservedAgentPresenceFromRevision } from '../lib/agentPresenceStore'
import { dataClient } from '../lib/supabase'
import { subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel } from '../lib/realtimeChannel'
import { UI_EVENTS } from '../lib/uiEvents'
import { rendererLogger } from '../lib/log'

/** Broadcasts only invalidate known caches. Reconnect always reads authoritative snapshots. */
export function useIdentityLifecycle(userId: string | null | undefined, getRepository: () => Promise<AccountImRepository>, reload: () => Promise<unknown>): void {
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    if (!userId) return
    let active = true
    const invalidate = async (id: string | null) => {
      const repository = await getRepository()
      if (!active) return
      const snapshot = repository.snapshot()
      const known = new Set([...snapshot.identity.map(row => row.id), ...snapshot.membership.map(row => row.identityId)])
      if (id !== null && !known.has(id)) return
      const ids = id === null ? [...known] : [id]
      await Promise.all([
        readDisplayIdentities(ids).then(rows => active && repository.putIdentities(rows)),
        refreshObservedAgentPresenceFromRevision(ids.map(agent_user_id => ({ agent_user_id }))),
        reloadRef.current(),
      ])
      if (active) window.dispatchEvent(new CustomEvent(UI_EVENTS.identityInvalidated, { detail: { id } }))
    }
    const refresh = (id: string | null) => { void invalidate(id).catch(error => rendererLogger('identity/lifecycle').error({ error }, 'Identity snapshot refresh failed')) }
    const channel = subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('gugu:identity:lifecycle', {
      config: { private: true, broadcast: { self: false } },
    }).on('broadcast', { event: 'identity_removed' }, ({ payload }) => {
      if (typeof payload?.id !== 'string' || typeof payload.removed_at !== 'string' || !Number.isFinite(Date.parse(payload.removed_at))) {
        rendererLogger('identity/lifecycle').error({}, 'Malformed identity removal invalidation')
        return
      }
      refresh(payload.id)
    }), 'identity lifecycle', { onSubscribed: () => refresh(null), reconnectWhenIdle: false })
    return () => { active = false; void unsubscribeAuthenticatedRealtimeChannel(channel) }
  }, [userId, getRepository])
}
