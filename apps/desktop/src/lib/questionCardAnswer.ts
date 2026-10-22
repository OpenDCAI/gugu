import { composerCardPreview, parseComposerCard, type QuestionCard } from '@gugu/core/shared/ui/taskCardModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { QuestionAnswer, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract'
import { platform } from '../platform'
import { chatDb } from './supabase'

/**
 * gugu-dev#181 ⑨: the owner answers an agent's question card in its group by replying to it — a pick on the card is
 * that reply, its words the choice. The reply's words are the pick when they are one of the card's choices, otherwise
 * the owner's own answer. The session settles once: an answer given elsewhere first wins (`accepted: false`).
 */
export function questionCardAnswers(card: QuestionCard, text: string): QuestionAnswer[] {
  const words = text.trim()
  return [card.options.includes(words) ? { selected: [words] } : { selected: [], other: words }]
}

export async function answerQuestionCard(card: QuestionCard, text: string): Promise<SessionpageSessionRespondResult> {
  const input = {
    conversationId: card.sessionId, itemId: card.questionId, kind: 'question' as const, answers: questionCardAnswers(card, text), by: 'desktop',
  }
  const here = (await platform.getLocalDeviceSelfSnapshot?.())?.device_id ?? null
  if (here !== card.deviceId) return (await import('@/mobile/agent-watch/sessionpage-rpc')).respondToSettlement(card.deviceId, input)
  const { rpcOn } = await import('@/session/renderer/lib/ipc')
  const result = await rpcOn(null).sessionTimeline.sessionRespond(input)
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}

/** After `sent` is written: when it replies to a question card asked of its sender, it is that card's answer. */
export async function answerIfQuestionReply(sent: MessageItem, senderUserId: string): Promise<void> {
  // The quote's preview is a cut of the card; only a question card's cut sends us to read the whole of it.
  if (!sent.reply_to_message_id || composerCardPreview(sent.reply_to_content)?.type !== 'question' || !sent.content) return
  const { data, error } = await chatDb.from('messages').select('content').eq('id', sent.reply_to_message_id).maybeSingle()
  if (error) throw new Error(`read question card ${sent.reply_to_message_id}: ${error.message}`)
  const card = parseComposerCard((data as { content?: string } | null)?.content)
  // Several questions, or several choices: the card says to answer in the session, where every part can be given.
  if (card?.type !== 'question' || card.ownerUserId !== senderUserId || card.options.length === 0) return
  await answerQuestionCard(card, sent.content)
}

/** What a settled question was answered with, in the owner's words (the picks, then what they wrote in). */
export function questionAnsweredText(optionId: string | null): string {
  let answers: unknown
  try { answers = optionId ? JSON.parse(optionId) : null } catch { return '' }
  if (!Array.isArray(answers)) return ''
  return answers.map((answer: QuestionAnswer) => [...(answer.selected ?? []), ...(answer.other ? [answer.other] : [])].join(', ')).join(' / ')
}
