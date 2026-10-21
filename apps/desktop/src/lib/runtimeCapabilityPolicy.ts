import { dataClient } from './supabase'

// @@@runtime-capability-policy (#647) - the global min_critical_capability lives in the DB
let policyPromise: Promise<number> | null = null

export function fetchMinCriticalCapability(): Promise<number> {
  if (policyPromise) return policyPromise
  const promise = (async () => {
    const { data, error } = await dataClient
      .schema('identity')
      .from('gugu_runtime_capability_policy')
      .select('min_critical_capability')
      .single()
    if (error || typeof data?.min_critical_capability !== 'number') {
      console.warn('[runtimeCapabilityPolicy] could not read min_critical_capability; stale-host flag disabled', error)
      policyPromise = null
      return 0
    }
    return data.min_critical_capability
  })()
  policyPromise = promise
  return promise
}
