// @@@1379 thread bootstrap — PostgREST 调 identity.get_thread_messages（返该 thread 根+回复历史，时间正序）。
// 给「agent 首进 thread 隔离 session」注入上下文 seed。host 注入进 handleAgentDeliverDeviceCommand 的
// fetchThreadMessages option。auth：service_role 或调用者是该 chat 成员。
// fail-loud：失败/返非数组即抛（调用方 deviceCommandRuntime 告警 + 不阻塞投递、下次重试，不静默吞）。
// （原居 groupRouter/deliveryGate.ts；#2008 product spec 移除整个 groupRouter 评分层后迁出独立成文件。）
import { getSupabaseAnonKey, getSupabaseUrl } from './config'
import type { ThreadMessageRow } from '../local/agent/threadBootstrap'

// 公共 PostgREST RPC POST helper：拼 URL + headers，返回 Response。
function postIdentityRpc(accessToken: string, fnName: string, body: unknown): Promise<Response> {
  return fetch(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'identity',
      'Content-Profile': 'identity',
    },
    body: JSON.stringify(body),
  })
}

export async function fetchThreadMessagesViaRest(
  chatId: string,
  threadRootId: string,
  accessToken: string | undefined,
): Promise<ThreadMessageRow[]> {
  if (!accessToken) throw new Error('fetchThreadMessagesViaRest: no accessToken')
  const resp = await postIdentityRpc(accessToken, 'get_thread_messages', { p_chat_id: chatId, p_thread_root_id: threadRootId })
  if (!resp.ok) throw new Error(`get_thread_messages ${resp.status}`)
  const data = (await resp.json()) as Array<{ sender_user_id: string; content: string; created_at: string }> | null
  if (!Array.isArray(data)) throw new Error('get_thread_messages returned non-array')
  return data.map((r) => ({ senderUserId: r.sender_user_id, content: r.content, createdAt: r.created_at }))
}
