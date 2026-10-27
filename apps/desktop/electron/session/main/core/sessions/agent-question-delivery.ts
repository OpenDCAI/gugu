import { questionAnswerError, type PendingRequest, type Settlement } from '@gugu/session-core/session-record';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { log } from '@main/lib/logger';
import type { AskAnswer } from '../asks';

type Question = PendingRequest & { origin: NonNullable<PendingRequest['origin']> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The archive owns the question and stable outbox id, rather than a process-local callback. */
export function questionDeliveryPayload(sourceLink: string | undefined, answerMessageId: string) {
  return { sourceLink: sourceLink ?? null, answerMessageId, deliveryVersion: 1 };
}

export function restoredAgentQuestion(settlement: Settlement): { request: Question; answerMessageId: string; answer?: AskAnswer } | null {
  if (settlement.origin?.source !== 'agent-question' || settlement.kind !== 'question' || !settlement.questions?.length
    || !settlement.title || !(['pending', 'resolved'].includes(settlement.state) || settlement.state === 'cancelled' && settlement.resolvedBy === 'upgrade')) return null;
  const payload = settlement.origin.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (data.sourceLink != null && (typeof data.sourceLink !== 'string' || !parseConversationLink(data.sourceLink)?.messageId)) return null;
  const answerMessageId = data.deliveryVersion === 1 && typeof data.answerMessageId === 'string' ? data.answerMessageId : '';
  if (!uuid.test(answerMessageId)) return null;
  const request: Question = { itemId: settlement.itemId, kind: 'question', title: settlement.title,
    questions: settlement.questions, options: settlement.options ?? settlement.questions[0].options,
    ...(settlement.askedAt !== undefined ? { askedAt: settlement.askedAt } : {}),
    origin: { source: 'agent-question', payload: questionDeliveryPayload(typeof data.sourceLink === 'string' ? data.sourceLink : undefined, answerMessageId) } };
  if (settlement.state === 'pending') return { request, answerMessageId };
  if (settlement.state === 'cancelled') return { request, answerMessageId, answer: { optionId: 'withdrawn', by: 'upgrade' } };
  if (!settlement.optionId) return null;
  try {
    const answers: unknown = JSON.parse(settlement.optionId);
    if (!Array.isArray(answers) || questionAnswerError(settlement.questions, answers)) return null;
    return { request, answerMessageId, answer: { optionId: 'answered', by: settlement.resolvedBy ?? 'owner', answers } };
  } catch { return null; }
}

export function deliverAgentQuestionAnswer(sessionId: string, projectId: string, request: Question, answerMessageId: string,
  result: Promise<import('../asks').AskResult>): void {
  void result.then(async (answer) => {
    if (typeof answer === 'string') return;
    const submitted = Boolean(answer.answers);
    const sourceLink = (request.origin.payload as { sourceLink?: string }).sourceLink;
    const source = sourceLink ? parseConversationLink(sourceLink) : null;
    const resultText = JSON.stringify({ question_id: request.itemId, state: submitted ? 'answered' : 'withdrawn',
      questions: request.questions?.map(q => q.question), ...(submitted ? { answers: answer.answers } : {}),
      ...(sourceLink ? { source_link: sourceLink } : {}),
      ...(source?.messageId ? { reply_destination: { chat_id: source.chatId, reply_to_message_id: source.messageId } } : {}),
    }).replaceAll('<', '\\u003c');
    const { sendMessage } = await import('./sendMessage');
    const sent = await sendMessage({ projectId, sessionId, clientMessageId: answerMessageId,
      text: `<gugu_question_answer>\n${resultText}\n</gugu_question_answer>\nThe owner explicitly ${submitted ? 'submitted these answers' : 'withdrew this question'} in Gugu. Resume only the corresponding work; forward the answer to its executor. Any reply about this work belongs to reply_destination, never an unrelated later greeting.`, kind: 'session-direct' });
    if (sent.status === 'outcome-unknown') log.warn('agent question answer delivery outcome is unknown', { sessionId, itemId: request.itemId });
  }).catch((error: unknown) => log.error('agent question answer delivery failed', { sessionId, itemId: request.itemId, error: String(error) }));
}
