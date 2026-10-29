import { agentFailureNeedsModelChoice } from '@gugu/core/shared/agentQuotaReason'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { turnFailureReason } from '@gugu/core/shared/ui/systemNotice'

export type TurnFailureGroup = { count: number; recovered: boolean }
export type TurnFailureMessage = MessageItem & { turnFailure?: TurnFailureGroup }

/** Render-only grouping. The stored rows, markers and retry command identities are untouched. */
export function projectTurnFailureMessages(messages: readonly MessageItem[]): TurnFailureMessage[] {
  const rows: TurnFailureMessage[] = []
  const consecutive = new Map<string, { line: string; index: number }>()
  const pending = new Map<string, number[]>()
  for (const message of messages) {
    const line = JSON.stringify([message.chat_id, message.thread_root_id ?? null])
    const key = JSON.stringify([line, message.sender_user_id])
    const reason = message.retracted_at ? null : turnFailureReason(message)
    if (reason && !agentFailureNeedsModelChoice(reason) && reason !== 'notAdmitted' && reason !== 'undelivered') {
      const previous = consecutive.get(key)
      if (previous) {
        rows[previous.index] = { ...message, turnFailure: { count: rows[previous.index].turnFailure!.count + 1, recovered: false } }
      } else {
        const index = rows.length
        rows.push({ ...message, turnFailure: { count: 1, recovered: false } })
        consecutive.set(key, { line, index })
        pending.set(key, [...(pending.get(key) ?? []), index])
      }
      continue
    }
    if (message.content_type !== 'system') {
      for (const [entry, group] of consecutive) if (group.line === line) consecutive.delete(entry)
      if (!message.retracted_at && message.seq > 0 && message.local_send_state !== 'failed' && message.local_send_state !== 'sending') {
        for (const index of pending.get(key) ?? []) rows[index].turnFailure = { ...rows[index].turnFailure!, recovered: true }
        pending.delete(key)
      }
    }
    rows.push(message)
  }
  return rows
}
