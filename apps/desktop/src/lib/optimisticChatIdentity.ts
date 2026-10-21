import { readChatListIdentities } from './chatListIdentityCompleteness'
import { rendererLogger } from './log'
import { currentAuthSessionSignal } from './authSessionLoss'
import { imSelectors, type AccountImRepository } from './imRepository'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ChatListProjectionLedger } from '../store/chatListProjection'

const optimisticChatLog = rendererLogger('chat/optimistic-row')

/**
 * @@@optimistic-peer-identity (#4314) — 把一条乐观会话行的对端身份补齐并发布，让**行与身份一起落地**。
 *
 * 为什么需要它：`open_dm` 刚开出来的 agent 私聊，它的对端身份本地必然还没有 —— 那正是「新建 agent」
 * 这条路每一次的形态。把行丢掉、改发一次整表刷新（#3661 的做法）在这条路上因此恒定失效：用户已经被
 * 送进这条会话，却停在一块空面板上，看起来就是「没跳过去」。
 *
 * 用会话列表**同一份带重试的身份读取**：刚建出来的身份行会短暂读不到，一读定生死会把「还没到」
 * 判成「没有」，把这条路推回原来的失败形状。重试预算耗尽仍读不到就 fail loud，
 * ❌ 不登记一行没有名字的会话。
 */
export async function publishPeerIdentityForOptimisticChat(
  repository: AccountImRepository,
  peerUserId: string,
  signal: AbortSignal = currentAuthSessionSignal(),
): Promise<void> {
  const identities = await readChatListIdentities([peerUserId], signal)
  const identity = identities.find((row) => row.id === peerUserId)
  if (!identity) throw new Error(`optimistic chat peer identity ${peerUserId} was not returned`)
  await repository.putIdentities([identity])
}

/**
 * 收下一条「调用方确知已存在、但对端身份本地还没有」的乐观会话行（刚 `open_dm` 出来的 agent 私聊），
 * 接下了返回 `true`。
 *
 * 权威刷新与身份补齐**并行**发：身份行刚建出来时那份读取会带重试，串在它后面等于让权威行也一起等。
 * 身份补齐后才登记这一行，并记进投影账本 —— 此后每次列表落地都把它补回去，不取决于这次 setState 与
 * 在途刷新谁先谁后。读不到身份就留痕放弃：❌ 不渲染一行没有名字的会话，也 ❌ 不像从前那样把行整个丢掉
 * 只发一次刷新（新建 agent 的身份必然未知，那条路在创建场景恒定失效，#4314）。
 */
export function adoptOptimisticChatRow(input: {
  chat: ChatItem
  repository: AccountImRepository | null
  ledger: Pick<ChatListProjectionLedger, 'rememberOptimistic'>
  refresh: () => void
  applyRow: (chat: ChatItem) => void
}): boolean {
  const peerUserId = input.chat.peer_user_id
  if (!peerUserId) return false
  const repository = input.repository
  if (repository && imSelectors.identitiesById(repository.snapshot())[peerUserId]) return false
  input.refresh()
  if (!repository) return true
  void publishPeerIdentityForOptimisticChat(repository, peerUserId)
    .then(() => {
      input.ledger.rememberOptimistic(input.chat)
      input.applyRow(input.chat)
    })
    .catch((err) => optimisticChatLog.error({ reason: String(err) }, 'optimistic chat peer identity unresolved'))
  return true
}
