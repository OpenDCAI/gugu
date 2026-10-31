import { randomUUID } from 'node:crypto';
import { ask } from '../asks';
import { deliverAgentQuestionAnswer, questionDeliveryPayload } from './agent-question-delivery';

/**
 * The card outlives its MCP request. Its explicit answer returns through the durable session inbox. The tool returns at
 * once (the agent's turn goes on), but the session waits on the person until it is answered or withdrawn: a question wait,
 * so the task card, the sidebar row and the rail read 「需要你」 meanwhile (gugu-dev#181 ⑨).
 */
export async function postAgentQuestion(input: {
  sessionId: string; projectId: string; sourceLink?: string;
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multi_select?: boolean }>;
}) {
  const itemId = `agent-question:${randomUUID()}`;
  const answerMessageId = randomUUID();
  const questions = input.questions.map((question) => ({
    question: question.question, ...(question.header ? { header: question.header } : {}), multiSelect: question.multi_select === true,
    options: question.options.map((option) => ({ optionId: option.label, name: option.label, ...(option.description ? { description: option.description } : {}) })),
  }));
  if (!questions.length || questions.some((q) => new Set(q.options.map((o) => o.optionId)).size !== q.options.length)) throw new Error('Questions require distinct options');
  const request = {
    itemId, kind: 'question', title: questions[0].question, questions, options: questions[0].options, askedAt: Date.now(),
    origin: { source: 'agent-question', payload: questionDeliveryPayload(input.sourceLink, answerMessageId) },
  } as const;
  const answer = ask(input.sessionId, request, { signal: new AbortController().signal });
  const immediate = await Promise.race([answer, Promise.resolve(undefined)]);
  if (typeof immediate === 'string') throw new Error(`Question could not be published: ${immediate}`);
  deliverAgentQuestionAnswer(input.sessionId, input.projectId, request, answerMessageId, answer);
  return { state: 'pending', question_id: itemId, ...(input.sourceLink ? { source_link: input.sourceLink } : {}),
    next: 'The card is waiting for explicit submission. Continue receiving other requests; its answer arrives as a new gugu_question_answer delivery. Do not poll or treat pending as consent.' };
}
