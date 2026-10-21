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
