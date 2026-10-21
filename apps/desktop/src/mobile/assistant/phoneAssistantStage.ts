import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

/**
 * 还没能打开它那条私聊时,这一格说哪一步(与桌面 assistant-view 同一套分法,❌ 读不到当成「还没开通」):
 * 在认它是谁(在读 / 读不到)→ 问管家(没问到 / 问不到)→ 它还不存在 = 给它安家的引导(会员一键领取、非会员引导开会员;
 * 手机上装不了它,引导里的「装在这台电脑上」那一条不出)→ 私聊在开 / 开不了。
 */
export type PhoneAssistantStage =
  | { stage: 'cloud-loading' }
  | { stage: 'cloud-unreadable' }
  | { stage: 'onboarding'; snapshot: CloudComputerSnapshot | null }
  | { stage: 'identity'; state: 'loading' | 'unreadable' }
  | { stage: 'chat-opening' }
  | { stage: 'chat-failed'; retry: () => void }
  | { stage: 'ready' }

/** 这一格此刻是哪一步(纯函数,单测直接测):先看它和私聊,再看认它那一步,再看管家,最后才是引导。 */
export function phoneAssistantStage(input: {
  found: boolean
  chatId: string | null
  chatFailed: boolean
  retryChat: () => void
  snapshot: CloudComputerSnapshot | null
  /** 管家那边有结论了(没开放 / 有快照 / 没问到但知道原因):false = 还在读。 */
  cloudKnown: boolean
  cloudLoadFailed: boolean
  identity: { loading: boolean; agentId: string | null; error: string | null }
}): PhoneAssistantStage {
  const { found, chatId, snapshot, identity } = input
  if (found && chatId) return { stage: 'ready' }
  if (found) return input.chatFailed ? { stage: 'chat-failed', retry: input.retryChat } : { stage: 'chat-opening' }
  // 标记读到了、通讯录里还没有那一位 = 还在读(开通刚建好它),❌ 说「没有」。
  if (identity.loading || identity.agentId) return { stage: 'identity', state: 'loading' }
  // 读不到 ≠ 没有它:如实说读不到,❌ 把人送进「安家」再建一个。
  if (identity.error) return { stage: 'identity', state: 'unreadable' }
  if (!snapshot) {
    if (input.cloudLoadFailed) return { stage: 'cloud-unreadable' }
    if (!input.cloudKnown) return { stage: 'cloud-loading' }
  }
  return { stage: 'onboarding', snapshot }
}
