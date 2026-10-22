import { beforeEach, expect, it, vi } from 'vitest'
import type { HostAnswer } from '../../../apps/desktop/electron/session/main/core/session-timeline/service'
const mocks = vi.hoisted(() => ({ ask: vi.fn(), send: vi.fn(), error: vi.fn() }))
vi.mock('../../../apps/desktop/electron/session/main/core/session-timeline/service', () => ({ askHost: mocks.ask }))
vi.mock('../../../apps/desktop/electron/session/main/core/sessions/sendMessage', () => ({ sendMessage: mocks.send }))
vi.mock('@main/lib/logger', () => ({ log: { error: mocks.error } }))
import { postAgentQuestion } from '../../../apps/desktop/electron/session/main/core/sessions/agent-question'
import { readQuestionAnswerDelivery } from '../../../packages/session-core/src/session-record/question-answer'

const input = { sessionId: 'assistant', projectId: 'home', sourceLink: 'gugu-chat://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333', questions: [
  { question: 'Which Node?', options: [{ label: 'PATH' }, { label: 'Repository' }] },
] }
let answer: (value: HostAnswer | 'withdrawn' | 'unavailable') => void
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
  mocks.send.mockResolvedValue({ status: 'accepted', id: 'receipt' })
})

it('returns pending without holding the model turn, then delivers only the explicitly submitted answer', async () => {
  let posted: Awaited<ReturnType<typeof postAgentQuestion>> | undefined
  void postAgentQuestion(input).then((result) => { posted = result })
  await new Promise((resolve) => setTimeout(resolve, 0)) // one event-loop turn, without answering the card
  expect(posted).toMatchObject({ state: 'pending', source_link: input.sourceLink })
  // It is a wait the session holds (「需要你」 until answered), not a background ask.
  expect(mocks.ask).toHaveBeenCalledWith('assistant', expect.objectContaining({ itemId: posted!.question_id }), { signal: expect.any(AbortSignal) })
  expect(mocks.send).not.toHaveBeenCalled()
  answer({ optionId: 'answered', by: 'desktop', answers: [{ selected: ['PATH'] }] })
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
  const sent = mocks.send.mock.calls[0][0]
  expect(sent).toMatchObject({ sessionId: 'assistant', projectId: 'home', kind: 'session-direct' })
  expect(sent.text).toContain(posted!.question_id)
  expect(sent.text).toContain('"selected":["PATH"]')
  expect(sent.text).toContain(input.sourceLink)
  expect(sent.text).toContain('"reply_to_message_id":"33333333-3333-4333-8333-333333333333"')
  expect(mocks.ask.mock.calls[0][1].host.payload).toMatchObject({ answerMessageId: sent.clientMessageId, deliveryVersion: 1 })
  // The session's transcript reads this very text back as the owner's answer, one line, not the block (gugu-dev#181).
  expect(readQuestionAnswerDelivery(sent.text)).toEqual({ answer: 'PATH' })
  expect(mocks.error).not.toHaveBeenCalled()
})

it.each(['withdrawn', 'unavailable'] as const)('does not manufacture an answer when the host says %s', async (state) => {
  await postAgentQuestion(input)
  answer(state)
  await Promise.resolve()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('delivers an explicit withdrawal as withdrawal, never approval', async () => {
  await postAgentQuestion(input)
  answer({ optionId: 'withdrawn', by: 'phone' })
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
  expect(mocks.send.mock.calls[0][0].text).toContain('"state":"withdrawn"')
  expect(mocks.send.mock.calls[0][0].text).not.toContain('"answers"')
})

it('records a failed answer handoff instead of claiming it was delivered', async () => {
  mocks.send.mockRejectedValue(new Error('outbox write refused'))
  await postAgentQuestion(input)
  answer({ optionId: 'answered', by: 'desktop', answers: [{ selected: ['PATH'] }] })
  await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
})

it('refuses to claim a card was published when the calling session has disappeared', async () => {
  mocks.ask.mockResolvedValue('unavailable')
  await expect(postAgentQuestion(input)).rejects.toThrow('could not be published')
  expect(mocks.send).not.toHaveBeenCalled()
})

it('reads a withdrawn question back as withdrawn, and leaves other text alone', () => {
  expect(readQuestionAnswerDelivery('<gugu_question_answer>\n{"question_id":"q","state":"withdrawn","questions":["x"]}\n</gugu_question_answer>\nThe owner explicitly withdrew this question in Gugu.')).toEqual({ answer: null })
  expect(readQuestionAnswerDelivery('PATH')).toBeUndefined()
})
