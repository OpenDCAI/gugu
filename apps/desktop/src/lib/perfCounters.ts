import type { PerfCounters } from '../session/shared/renderer-metrics'

// Counts attempts, including failed transactions/RPCs and React render attempts.
// No timers, subscriptions, clocks, logging, or allocations on the write path.
let imTransactions = 0
let presenceBatches = 0
let presenceIds = 0
let contactsProviderRenders = 0

export function recordImTransaction(): void { imTransactions += 1 }
export function recordPresenceBatch(ids: number): void { presenceBatches += 1; presenceIds += ids }
export function recordContactsRender(): void { contactsProviderRenders += 1 }

export function readPerfCounters(): PerfCounters {
  return { imTransactions, presenceBatches, presenceIds, contactsProviderRenders }
}
