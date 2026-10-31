// #1231 PR1 — data-loading container for the /join/agent/<id> public landing.
//
// App.tsx has conditional early-returns, so the join route's data-loading hooks live here in
// a dedicated component (hooks always run in a stable order). Loads the public agent via the
// anon-capable fetchPublicAgentJoin and renders AgentJoinPage with real data + real CTAs:
//   - logged-in  → onStartChat: send a friend request to the agent, then enter the app.
//   - logged-out → onRequireLogin: leave the landing for the app root (login flow).
// A non-public / unknown agent → AgentJoinPage error state (no leak).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentJoinPage, type AgentJoinInfo } from './AgentJoinPage'
import { fetchPublicAgentJoin } from '../lib/publicAgent'
import { contactsService } from '../lib/contacts'
import { rendererLogger } from '../lib/log'
import type { AuthUser } from '../store/auth'

const publicAgentLog = rendererLogger('agent/public-join')

/** Leave the public landing and boot the normal app (login when logged-out, home when in). */
function enterApp(): void {
  window.location.assign(`${window.location.origin}/`)
}

const PLACEHOLDER: AgentJoinInfo = {
  id: '',
  displayName: '',
  avatar: null,
  bio: null,
  ownerDisplayName: null,
}

export function AgentJoinRoute({
  agentId,
  user,
  authLoading,
}: {
  agentId: string
  user: AuthUser | null
  authLoading: boolean
}) {
  const { t } = useTranslation('agents')
  const [agent, setAgent] = useState<AgentJoinInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPublicAgentJoin(agentId)
      .then((info) => {
        if (cancelled) return
        if (!info) {
          setError(t('public.unavailable'))
          setAgent(null)
        } else {
          setAgent(info)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        publicAgentLog.error({ error: err instanceof Error ? err.message : String(err) }, 'public join lookup failed')
        setError(t('public.unavailable'))
        setAgent(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [agentId, t])

  const handleStartChat = (targetAgentId: string): void => {
    if (!user) { enterApp(); return }
    // Real action: send the friend request, then enter the app where the new
    // conversation/contact is visible. Already-friends / duplicate request errors are
    // non-fatal here — we still enter the app.
    void contactsService
      .sendRequest(user.id, targetAgentId)
      .catch((error: unknown) => { publicAgentLog.error({ error }, 'public join contact request failed') })
      .finally(() => { enterApp() })
  }

  return (
    <AgentJoinPage
      agent={agent ?? PLACEHOLDER}
      isLoggedIn={!authLoading && user !== null}
      loading={authLoading || loading}
      error={error}
      onStartChat={handleStartChat}
      onRequireLogin={enterApp}
    />
  )
}
