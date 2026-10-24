import type { QuestionAnswer, SettlementQuestion } from './contract'

/** Validate against this exact question generation before either a native or host answer is committed. */
export function questionAnswerError(questions: readonly SettlementQuestion[], answers: readonly QuestionAnswer[]): string | null {
  if (answers.length !== questions.length) return '答案份数与题目不一致'
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]
    if (!answer || !Array.isArray(answer.selected) || answer.selected.some((id) => !question.options.some((option) => option.optionId === id))) return '答案包含失效的选项'
    if (new Set(answer.selected).size !== answer.selected.length) return '答案包含重复的选项'
    if (!question.multiSelect && answer.selected.length > 1) return '单选题只能选择一项'
    if (!question.multiSelect && !answer.selected.length && !answer.other?.trim()) return '请回答每一道题'
  }
  return null
}

/** An answer in the owner's words — the picks, then what they wrote in; one question after another. Said the same way
 *  on the group's question card and in the session's transcript. */
export function questionAnswerText(answers: readonly QuestionAnswer[]): string {
  return answers.map((answer) => [...(answer.selected ?? []), ...(answer.other?.trim() ? [answer.other.trim()] : [])].join(', ')).join(' / ')
}

const ANSWER_DELIVERY = /^<gugu_question_answer>\n([^\n]*)\n<\/gugu_question_answer>/

/**
 * The host's answer to an agent's question, as it reaches the session (`<gugu_question_answer>`, agent-question-delivery.ts),
 * read back for the transcript: what the owner answered, or `null` when they withdrew the question. Not that block: `undefined`.
 */
export function readQuestionAnswerDelivery(text: string): { answer: string | null } | undefined {
  const block = ANSWER_DELIVERY.exec(text)
  if (!block) return undefined
  let data: unknown
  try { data = JSON.parse(block[1]!) } catch { return undefined }
  const fact = data as { state?: unknown; answers?: unknown }
  if (fact.state === 'withdrawn') return { answer: null }
  return fact.state === 'answered' && Array.isArray(fact.answers) ? { answer: questionAnswerText(fact.answers as QuestionAnswer[]) } : undefined
}
