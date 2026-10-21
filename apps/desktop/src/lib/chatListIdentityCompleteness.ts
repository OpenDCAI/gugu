import { readDisplayIdentities } from './identityReadAdapter'

/**
 * 刚建出来的身份行会短暂读不到,所以带重试;乐观会话行复用它,❌ 别抄第二份重试预算 (#4314)。
 * ⚠️ **会话列表不再走这条**:投影对缺失身份的对端不发布该行,下一条 `agent_changed` 一到就补上
 * (spec 的装配那一节)—— 列表的完备性由代数保证,不由重试预算保证。
 */
export async function readChatListIdentities(
  ids: readonly string[],
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof readDisplayIdentities>>> {
  const required = [...new Set(ids.filter(Boolean))]
  let identities: Awaited<ReturnType<typeof readDisplayIdentities>> = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    signal.throwIfAborted()
    identities = await readDisplayIdentities(required, signal)
    if (hasCompleteChatListIdentities(required, identities)) return identities
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return identities
}

export function hasCompleteChatListIdentities(
  requiredIds: readonly string[],
  identities: readonly { id: string }[],
): boolean {
  const present = new Set(identities.map((identity) => identity.id))
  return [...new Set(requiredIds.filter(Boolean))].every((id) => present.has(id))
}
