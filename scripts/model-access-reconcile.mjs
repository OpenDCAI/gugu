#!/usr/bin/env node
// @@@2503 平台额度结算巡检:把「已结束但没结算」的 model access 会话收干净。
//
// 为什么必须有这一趟:结算原本只在用户显式 revoke 时发生。会话如果是崩溃、被杀、或 TTL 到期
// 结束的,就没有任何人去 revoke 它 —— 网关那边照常计了量,咕咕账本这边一分没扣,等于白用。
// DB 侧的 public.model_access_reconcile_queue 早就建好并授给 service_role 了,缺的一直是叫它的人。
//
// 这个脚本只是「按门铃的手」:真正的结算逻辑在 model-access edge function 的 reconcile 分支里,
// 和用户 revoke 走同一个 settleSession。❌ 不要在这里重写一份结算——两份实现算出两个数字,就是
// 这套设计从头到尾在防的重复扣费。
//
// env(缺失即 throw,fail loud):
//   GUGU_SUPABASE_URL              — 目标环境(生产/测试)的 Supabase 地址
//   SUPABASE_SERVICE_ROLE_KEY      — service role;edge function 据此认这是巡检而非用户请求
//   MODEL_ACCESS_RECONCILE_LIMIT   — 单趟最多取多少条会话(默认 100,1..500);每条会话单独一个请求
//
// 退出码:有任何一个会话结算失败即非零退出。没收上来的钱不算成功——半趟当成功报,正是
// 「悄悄少收」最容易藏身的地方。

const url = requireEnv('GUGU_SUPABASE_URL').replace(/\/$/, '')
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const limit = Number(process.env.MODEL_ACCESS_RECONCILE_LIMIT ?? '100')
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  throw new Error(`MODEL_ACCESS_RECONCILE_LIMIT 必须是 1..500 的整数,收到 ${process.env.MODEL_ACCESS_RECONCILE_LIMIT}`)
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

// @@@4467 按有界的批推进:队列取出至多 limit 条,**一条会话一个请求**、串行。
// edge worker 的 CPU 预算按 worker 算(软 1s / 硬 2s),整批塞进一个请求会烧穿它,连同同一 worker 上
// 别人的请求一起被取消。一条一个请求 ⇒ 被取消的只是那一条;每条结算完就在库里单独落定
// (settle 按 request id 幂等、mark_reconciled 按会话),已完成的不回滚、下一趟也不会再取到。
// 失败的那条记下、继续下一条 —— 一条毒会话不能挡住它后面所有人的账。
const headers = {
  'Content-Type': 'application/json',
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
}

const queueResponse = await fetch(`${url}/rest/v1/rpc/model_access_reconcile_queue`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ p_limit: limit }),
})
if (!queueResponse.ok) {
  throw new Error(`读结算队列失败(HTTP ${queueResponse.status}):${(await queueResponse.text()).slice(0, 300)}`)
}
const queue = await queueResponse.json()
if (!Array.isArray(queue)) throw new Error('结算队列返回的不是数组')

const tally = { scanned: queue.length, settled: 0, partial: 0, pending_attribution: 0, skipped: 0, charged_credits: 0, requests: 0 }
const failures = []
for (const row of queue) {
  const sessionId = row?.session_id
  if (typeof sessionId !== 'string' || !sessionId) {
    failures.push({ session_id: null, error: `队列行没有 session_id:${JSON.stringify(row).slice(0, 200)}` })
    continue
  }
  const response = await fetch(`${url}/functions/v1/model-access`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'reconcile', session_id: sessionId }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload) {
    failures.push({ session_id: sessionId, http: response.status, error: payload?.error ?? '非 JSON 响应' })
    continue
  }
  if (payload.skipped) { tally.skipped += 1; continue }
  // 一条会话一次请求只结算有限条日志(见 edge 的 MAX_UNSETTLED_LOGS_PER_REQUEST);还有剩的是「推进了一段」,
  // 不是失败,下一趟接着做。
  if (payload.settled) tally.settled += 1
  else if (Number(payload.remaining ?? 0) > 0) tally.partial += 1
  else tally.pending_attribution += 1
  tally.charged_credits += Number(payload.charged_credits ?? 0)
  tally.requests += Number(payload.requests ?? 0)
}

// @@@2503 顺带把「卡住的池子调整」报出来(每趟一次,不是每条会话一次)。这类行不是巡检造成的,也不该由它
// 自动处理(增量语义不可自动重试),但它会让那个用户签不出任何新会话 —— 等用户来报就太晚了。
// 人拿着 idempotency_key 去 billing.gateway_pool_resolve_pending 定案。读不出不让整趟失败,但要说出来。
let stuckPoolAdjustments = null
const stuckResponse = await fetch(`${url}/rest/v1/rpc/gateway_pool_pending_adjustments`, {
  method: 'POST',
  headers: { ...headers, 'Content-Profile': 'billing' },
  body: JSON.stringify({ p_older_than_seconds: 300 }),
})
if (stuckResponse.ok) stuckPoolAdjustments = await stuckResponse.json()
else console.error(`读卡住的池子调整失败(HTTP ${stuckResponse.status}):${(await stuckResponse.text()).slice(0, 300)}`)

// 扫到 0 条是正常的常态(没有过期未结算的会话),和「扫到了但结算失败」必须分得开。
console.log(JSON.stringify({ ...tally, failures, stuck_pool_adjustments: stuckPoolAdjustments }, null, 2))
if (Array.isArray(stuckPoolAdjustments) && stuckPoolAdjustments.length > 0) {
  console.error(
    `${stuckPoolAdjustments.length} 条池子调整卡住超过 5 分钟;受影响的用户在逐条定案之前签不出也续不了会话:`
    + stuckPoolAdjustments.map((row) => String(row.idempotency_key)).join(', '),
  )
}

if (failures.length > 0) {
  throw new Error(`model-access reconcile 未收干净:${failures.length}/${queue.length} 条会话失败`)
}
