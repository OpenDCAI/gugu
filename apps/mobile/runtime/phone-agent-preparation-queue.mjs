import { phoneRequestFailure } from './phone-agent-network.mjs'

const maxWaitMs = 30 * 60_000

export const phonePreparationExpired = (job, now = Date.now()) => job.status === 'queued' && job.networkWait?.expiresAt <= now

/** Only a failed preparation may resume; model/tool failures and uncertain writes never replay. */
export function deferPhonePreparation(state, job, error, now = Date.now(), random = Math.random) {
  const failure = phoneRequestFailure(error)
  if (!error.phonePreparation || !failure.retryable || job.cancelRequested) return false
  job.networkWait ??= { since: now, expiresAt: now + maxWaitMs }
  if (job.networkWait.expiresAt <= now) return false
  job.networkWait.failure = failure
  const failures = (state.preparationBackoff?.failures ?? 0) + 1
  // One phone-wide cooldown, not one polling/retry loop per queued task. Spread recovery probes.
  const cooldown = Math.min(120_000, 30_000 * 2 ** Math.min(failures - 1, 3)) * (0.5 + random() * 0.5)
  state.preparationBackoff = { failures, awaitingHeartbeat: true, notBefore: Math.max(now + cooldown, failure.retryAt ?? 0) }
  job.status = 'queued'; job.phase = 'waiting_network'
  delete job.error; delete job.finishedAt
  return true
}

export function phonePreparationMayRun(state, now = Date.now()) {
  const backoff = state.preparationBackoff
  return !backoff || (!backoff.awaitingHeartbeat && now >= backoff.notBefore)
}

export function phonePreparationWaitError(job) {
  return Object.assign(new Error('phone preparation recovery expired'), job.networkWait.failure)
}
