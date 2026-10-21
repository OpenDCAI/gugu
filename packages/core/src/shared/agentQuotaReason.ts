export type AgentQuotaReason = 'weekly' | 'monthly' | 'exhausted' | 'rate-limited'

export function agentModelUnavailable(raw: string | null | undefined): boolean {
  return /model access HTTP 503|model[^\n]*(?:service.unavailable|is not available|is at capacity|not found|does not exist)|当前模型暂时不可用/i.test(raw ?? '')
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
