import { PLATFORM_STANDALONE_SEARCH_ROUTE, platformStandaloneSearchGranted } from '@gugu/session-core/agents/plugins'
import { platformModelIdFromNativeOption } from '@gugu/session-core/acp/platform-model-address'
import type { SessionWebSearch } from '../mcp/gugu-web-search-tool'
import { getSessions } from '../session/main/core/sessions/getSessions'
import { claudePlatformSearchSession, credentialForRuntimeRequest } from './sessionpage-platform-model'
import { withinCredentialDeadline } from './platform-credential-proxy'
import { anySignal } from '@gugu/core/shared/anySignal'

/** No retries: a search request is metered separately from inference. */
export function platformWebSearchForSession(sessionId: string): SessionWebSearch {
  return {
    available: () => {
      const held = claudePlatformSearchSession(sessionId)
      return platformStandaloneSearchGranted(held?.callableRoutes, held?.model)
    },
    run: async (query, requestSignal) => {
      const signal = anySignal([requestSignal, AbortSignal.timeout(60_000)])
      const selected = (await getSessions()).find(session => session.id === sessionId)?.model?.trim()
      let held = claudePlatformSearchSession(sessionId)
      const option = selected || held?.model
      const model = option ? platformModelIdFromNativeOption(option) ?? option : null
      if (!held || !platformStandaloneSearchGranted(held.callableRoutes, model)) {
        throw new Error('Web search is unavailable for the current platform model')
      }
      let token: string
      try {
        token = await withinCredentialDeadline(credentialForRuntimeRequest(sessionId))
      } catch {
        throw new Error('Web search could not obtain a valid platform credential; retry after restoring platform access')
      }
      // Renewal may replace the gateway or end the session while the credential is being obtained.
      held = claudePlatformSearchSession(sessionId)
      if (!held || !platformStandaloneSearchGranted(held.callableRoutes, model)) {
        throw new Error('Web search platform access is no longer available')
      }
      let response: Response
      try {
        response = await fetch(`${held.relayUrl.replace(/\/$/, '')}${PLATFORM_STANDALONE_SEARCH_ROUTE}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, model, commands: { search_query: [{ q: query }] } }),
          signal,
          redirect: 'error',
        })
      } catch {
        throw new Error(signal.aborted ? 'Web search was cancelled or timed out' : 'Web search could not reach the platform gateway')
      }
      if (!response.ok) {
        // Never echo arbitrary gateway bodies: they may contain credentials or private upstream details.
        const reason = response.status === 401 || response.status === 403 ? 'platform access was rejected'
          : response.status === 429 ? 'quota or rate limit was reached' : 'the gateway rejected the search request'
        await response.body?.cancel()
        throw new Error(`Web search failed (HTTP ${response.status}): ${reason}`)
      }
      let result: unknown
      try { result = await response.json() } catch {
        throw new Error(signal.aborted ? 'Web search was cancelled or timed out' : 'Web search gateway returned an invalid JSON response')
      }
      if (!result || typeof result !== 'object' || !('output' in result) || typeof result.output !== 'string') {
        throw new Error('Web search gateway response is missing its text output')
      }
      return result.output
    },
  }
}
