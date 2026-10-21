interface ChatDebugBridge {
  getActiveChatId?: () => string | null
  getMessagesCount?: () => number
  getCachedChatIds?: () => string[]
  getLoadingMessages?: () => boolean
  getMessagesCallCount?: () => number
  getCallCountsBySource?: () => Record<string, number>
  getRevalidateInFlight?: () => string[]
  // @@@1888 — 单调 heal 周期计数(e2e 用「计数递增」观测一次 heal 完成,替代 in-flight 双沿捕捉)。
  getHealCycleCount?: () => number
}

interface Window {
  __chatDebug?: ChatDebugBridge
}
