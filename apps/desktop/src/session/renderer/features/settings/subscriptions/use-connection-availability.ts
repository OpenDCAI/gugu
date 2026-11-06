import { useQuery } from '@tanstack/react-query'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { subscriptionKey } from './subscription-queries'

/** Same auth reading used by the harness model-credential predicate; payer is not a credential. */
export function useConnectionAvailability(
  providerId: string,
  machine: string | null,
  missingProgram = false,
  background = false
) {
  const query = useQuery({
    queryKey: [...subscriptionKey(machine, providerId), 'availability'],
    staleTime: 30_000,
    retry: background,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = await (
        await getAgentConfigRuntimeClient(machine)
      ).refreshAuthStatus({ providerId })
      if (!result.success)
        throw new Error('message' in result.error ? result.error.message : result.error.type)
      return result.data
    }
  })
  const credentialState =
    query.data?.kind === 'authenticated'
      ? 'usable'
      : query.data?.kind === 'unauthenticated' || missingProgram
        ? 'unusable'
        : 'failed'
  const state =
    background && query.data
      ? credentialState
      : query.isFetching || query.isPending
        ? 'checking'
        : query.error
          ? 'failed'
          : credentialState
  return { auth: query.data, state, refresh: query.refetch, error: query.error } as const
}
