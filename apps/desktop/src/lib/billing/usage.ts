// billing.usage_events 一行的形状(用量面板的读法在 lib/usage/cloud.ts)。
//
// 这张表同时是额度窗口的口径来源:billing.quota_windows 就是按 usage_events 求和算出两个窗口
// 已用了多少,所以流水和窗口讲的是同一笔账,不会各说各话。
// pending_attribution 是内部结算状态,不是用户活动。只有 usage_events 里的终局记录才进入用户面。
export interface UsageActivityRow {
  id: string
  model: string | null
  agent_user_id: string | null
  credits_charged: number
  input_tokens: number
  output_tokens: number
  created_at: string
}
