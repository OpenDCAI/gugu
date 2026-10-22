import type { ComposerCard } from '@gugu/core/shared/ui/taskCardModels'

/** Each card's name (its head, a quote's head) and its one-line form (chat list, reply previews), in `messaging`. */
export const composerCardCopy = {
  task: { head: 'message.taskCard.task', line: 'message.taskCard.line' },
  schedule: { head: 'message.taskCard.schedule', line: 'message.taskCard.scheduleLine' },
  question: { head: 'message.taskCard.question', line: 'message.taskCard.questionLine' },
} as const satisfies Record<ComposerCard['type'], { head: string; line: string }>
