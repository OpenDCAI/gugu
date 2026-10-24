import { composerCardPreview, type ComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { i18n } from '../i18n/runtime'

/** Each card's name (its head, a quote's head) and its one-line form (chat list, reply previews), in `messaging`. */
export const composerCardCopy = {
  task: { head: 'message.taskCard.task', line: 'message.taskCard.line' },
  schedule: { head: 'message.taskCard.schedule', line: 'message.taskCard.scheduleLine' },
  question: { head: 'message.taskCard.question', line: 'message.taskCard.questionLine' },
} as const satisfies Record<ComposerCard['type'], { head: string; line: string }>

/** A card's one-line form from the card or a cut-down preview of it; anything else stays as it is. */
export function composerCardLine(preview: string): string {
  const card = composerCardPreview(preview)
  if (!card) return preview
  return i18n.t(composerCardCopy[card.type].line, { ns: 'messaging', text: card.text })
}
