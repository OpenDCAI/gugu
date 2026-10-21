/**
 * 写入侧的引用完整性:**这一次要写进状态的引用 id 集合 ⊆ 这一次提交的身份**。
 *
 * 「谁存在」(行 / 关系)和「他长什么样」(身份)存在两张表里,写入方从前得自己**记得**把每个将要引用的 id 的
 * 身份也交上来 —— 没有类型保证、没有结构保证,每新增一个调用点就多一次忘记的机会,忘了就是静默空名字
 * (#5606:好友名下的公开 agent;#5610:群名册)。完备性判据早就作为纯函数存在(chatListIdentityCompleteness
 * 的 hasCompleteChatListIdentities),但只接在读取侧。这里把同一条判据接到写入侧,让契约从「靠人记」变成
 * 「忘了就在写入那一刻报」—— 报在 async 写路径里,是一条能定位的错误,不是某个 render 里的白屏。
 */
export function assertIdentityClosure(
  context: string,
  requiredIds: Iterable<string | null | undefined>,
  identities: readonly unknown[],
): void {
  const present = new Set<string>()
  for (const identity of identities) {
    const id = (identity as { id?: unknown } | null)?.id
    if (typeof id === 'string') present.add(id)
  }
  const missing = new Set<string>()
  for (const id of requiredIds) if (typeof id === 'string' && id !== '' && !present.has(id)) missing.add(id)
  if (missing.size === 0) return
  throw new Error(`[identity-closure] ${context}: ${missing.size} referenced id(s) have no identity in this commit: ${[...missing].join(', ')}`)
}
