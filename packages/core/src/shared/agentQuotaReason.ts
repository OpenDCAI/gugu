export type AgentQuotaReason = 'weekly' | 'monthly' | 'exhausted' | 'rate-limited'

/**
 * Why an agent reply failed, as the host records it on the failure row (see `shared/ui/systemNotice.ts`) and on a forum
 * assignment. Each one is also the key of its line under `agent.turnFailure` in the messaging i18n namespace.
 * notAdmitted = Gugu never handed the batch to the agent; undelivered = no running Gugu instance holds the agent;
 * outcomeUnknown = Gugu handed it over but cannot know whether the agent took it, and does not resend it.
 */
export const AGENT_FAILURE_REASONS = [
  'weeklyQuota', 'monthlyQuota', 'quota', 'rateLimited', 'modelUnavailable', 'authentication', 'network', 'timeout', 'generic', 'notAdmitted', 'undelivered', 'outcomeUnknown',
] as const
export type AgentFailureReason = (typeof AGENT_FAILURE_REASONS)[number]

export function agentModelUnavailable(raw: string | null | undefined): boolean {
  return /model access HTTP 503|model[^\n]*(?:service.unavailable|is not available|is at capacity|not found|does not exist)/i.test(raw ?? '')
}

/** Provider diagnostics are classified here; user-facing surfaces never display the raw error. */
export function agentQuotaReason(raw: string | null | undefined): AgentQuotaReason | null {
  const text = raw ?? ''
  if (/weekly.{0,30}(?:limit|quota)|(?:limit|quota).{0,30}weekly|周限|每周.{0,8}(?:额度|上限)/i.test(text)) return 'weekly'
  if (/monthly.{0,30}(?:limit|quota)|(?:limit|quota).{0,30}monthly|月限|每月.{0,8}(?:额度|上限)/i.test(text)) return 'monthly'
  if (/quota exceeded|insufficient_quota|insufficient credits|(?:hit|reached|exceeded).{0,30}usage limit|额度.{0,8}(?:不足|用完)|余额不足/i.test(text)) return 'exhausted'
  if (/rate[_ -]?limit|too many requests|(?:HTTP|status(?: code)?)[ :]+429/i.test(text)) return 'rate-limited'
  return null
}

const QUOTA_FAILURE = { weekly: 'weeklyQuota', monthly: 'monthlyQuota', exhausted: 'quota', 'rate-limited': 'rateLimited' } as const

/** The provider-side reason a raw error names; null when it names none. */
export function agentFailureReason(raw: string | null | undefined): AgentFailureReason | null {
  const quota = agentQuotaReason(raw)
  if (quota) return QUOTA_FAILURE[quota]
  if (agentModelUnavailable(raw)) return 'modelUnavailable'
  const text = raw ?? ''
  if (/\b(?:401|403)\b.*(?:unauthorized|forbidden)|(?:HTTP|status(?: code)?)[ :]+(?:401|403)|authentication[_ -]?error|invalid[_ -]?api[_ -]?key/i.test(text)) return 'authentication'
  if (/ETIMEDOUT|\btimeout\b|timed out/i.test(text)) return 'timeout'
  if (/ECONNRESET|EPIPE|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|fetch failed/i.test(text)) return 'network'
  return null
}

/** Another model would get past it: the failure offers 「换模型」. */
export function agentFailureNeedsModelChoice(reason: AgentFailureReason | null): boolean {
  return reason === 'weeklyQuota' || reason === 'monthlyQuota' || reason === 'quota' || reason === 'modelUnavailable'
}
