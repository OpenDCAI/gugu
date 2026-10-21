import type { MessageItem } from '@gugu/core/shared/types/chat'
import { agentStreamKey } from '../lib/agentStreamState'

/**
 * #1577 M3 — ThreadScope 单一对象。
 *
 * 「当前会话作用域」在 thread 维度上的内聚真值。把过去散落各处独立读 `activeThreadRootId`、再各自决定
 * 「用哪份消息列表 / 哪个复合 key」的判断收敛到这里一处,杜绝新增路径只读了 rootId 却忘了配套的 scope 列表
 * / key → 漂移 bug(#1575「话题运行中卡死」即此类:清活动只查了 messages 没查 threadMessages)。
 *
 * 故意只覆盖 thread 维度:activeChatId 是独立成熟字段、不在漂移问题内,不并进来;streamKey 用独立纯函数
 * (`threadScopeStreamKey`)而非塞进对象,避免 context 里函数引用身份抖动。
 */
export interface ThreadScope {
  /** = activeThreadRootId;null = 主时间线。 */
  rootId: string | null
  /** rootId !== null —— 是否在话题视图。 */
  isOpen: boolean
  /**
   * 本作用域「真正承载回复」的消息列表:isOpen ? threadMessages : messages。
   * 反漂移核心 —— getMessages 把 thread_root_id 非空的回复过滤出主线,故话题回复只在 threadMessages。
   */
  messages: MessageItem[]
  /** isOpen ? loadingThread : loadingMessages。 */
  loading: boolean
}

/**
 * 唯一的 ThreadScope 派生入口。store 与 hooks 都走它,故「主线/话题列表选取」只有这一份实现。
 * loadingThread/loadingMessages 可省(hook 不关心 loading,默认 false)。
 */
export function deriveThreadScope(input: {
  rootId: string | null
  messages: MessageItem[]
  threadMessages: MessageItem[]
  loadingThread?: boolean
  loadingMessages?: boolean
}): ThreadScope {
  const isOpen = input.rootId !== null
  return {
    rootId: input.rootId,
    isOpen,
    messages: isOpen ? input.threadMessages : input.messages,
    loading: isOpen ? (input.loadingThread ?? false) : (input.loadingMessages ?? false),
  }
}

/**
 * 该作用域的 (chat, thread) 复合 key —— activity / stream 同款。唯一派生入口,杜绝各处自己拼
 * `agentStreamKey(chatId, rootId)` 时漏带 rootId。chatId 为空(无活动会话)→ null。
 */
export function threadScopeStreamKey(chatId: string | null, scope: ThreadScope): string | null {
  return chatId ? agentStreamKey(chatId, scope.rootId) : null
}
