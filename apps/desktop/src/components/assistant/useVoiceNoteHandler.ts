import { useSyncExternalStore } from 'react'
import { readAssistantShellBridge, type AssistantVoiceNoteHandler } from '../../lib/assistantShellBridge'

const noop = () => () => undefined

/**
 * #7199 会话页那一侧登记在桥上的录音机(没登记 = null),和它此刻在不在录。
 * 录着离开助理 App 时登记照留(会话页那侧的约定),所以栏上那一格、会议提醒在 App 外头也知道正在录。
 */
export function useVoiceNoteHandler(): { handler: AssistantVoiceNoteHandler | null; recording: boolean } {
  const bridge = readAssistantShellBridge()
  const handler = useSyncExternalStore(bridge?.subscribeVoiceNoteHandler ?? noop, () => bridge?.getVoiceNoteHandler() ?? null)
  const recording = useSyncExternalStore(handler?.subscribe ?? noop, () => handler?.busy() ?? false)
  return { handler, recording }
}
