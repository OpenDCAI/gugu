import type { QuestionAnswer, Settlement, SettlementQuestion } from '@gugu/session-core/session-record/contract'

/** The composer only hosts a question that still needs an answer, never a stale receipt. */
export function latestAgentQuestion(settlements: Readonly<Record<string, Settlement>>): Settlement | null {
  const questions = Object.values(settlements).filter((item) => item.kind === 'question' && (item.questions?.length ?? 0) > 0)
  return questions.find((item) => item.state === 'pending') ?? null
}

export function questionAnswerReady(question: SettlementQuestion, answer: QuestionAnswer, custom: boolean): boolean {
  if (custom && !answer.other?.trim()) return false
  if (answer.selected.some((id) => !question.options.some((option) => option.optionId === id))) return false
  return question.multiSelect || answer.selected.length === 1 || Boolean(answer.other?.trim())
}

/** A provider may finish streaming the question input under the same tool-call id. Never reuse an answer for changed words. */
export function agentQuestionDraftKey(scope: string, settlement: Settlement): string {
  return JSON.stringify([scope, settlement.itemId, settlement.askedAt, settlement.questions])
}
