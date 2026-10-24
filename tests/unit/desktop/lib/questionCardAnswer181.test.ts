// gugu-dev#181 ⑨:主人在群里回问题卡(点卡上的选项 = 引用卡回一句、正文就是选项名)就是作答 —— 同一个 respond,
// 本机的会话走本机,别的机器上的走那台机器;不是问我的、不是问题卡、问了几道的,都不答。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeComposerCard, type QuestionCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import type { MessageItem } from '../../../../packages/core/src/shared/types/chat'

const card: QuestionCard = {
  v: 1, type: 'question', text: '要把初始化提前吗？', options: ['提前', '先不动'], ownerUserId: 'owner-1',
  questionId: 'agent-question:q1', sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-here', machineLabel: 'Mac',
}
let stored: QuestionCard = card
const reads: string[] = []
const local = vi.fn(async (_input: unknown) => ({ ok: true, value: { accepted: true } }))
const remote = vi.fn(async (_device: string, _input: unknown) => ({ accepted: true }))

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { getLocalDeviceSelfSnapshot: async () => ({ device_id: 'device-here' }) } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => { reads.push(id); return { data: { content: serializeComposerCard(stored) }, error: null } } }) }) }) },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionRespond: local } }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ respondToSettlement: remote }))

const { answerIfQuestionReply, questionAnsweredText, questionCardAnswers } = await import('../../../../apps/desktop/src/lib/questionCardAnswer')

const reply = (content: string, quoted: string | null = serializeComposerCard(card).slice(0, 100)) =>
  ({ id: 'reply-1', content, reply_to_message_id: 'card-msg', reply_to_content: quoted } as unknown as MessageItem)

beforeEach(() => { stored = card; reads.length = 0; local.mockClear(); remote.mockClear() })

describe('a reply to a question card answers it (gugu-dev#181 ⑨)', () => {
  it('its words are the pick when they are one of the choices, otherwise the owner\'s own answer', () => {
    expect(questionCardAnswers(card, ' 提前 ')).toEqual([{ selected: ['提前'] }])
    expect(questionCardAnswers(card, '先把 3 个文件发我看')).toEqual([{ selected: [], other: '先把 3 个文件发我看' }])
  })

  it('the owner\'s reply answers through the session on this machine', async () => {
    await answerIfQuestionReply(reply('提前'), 'owner-1')
    expect(local).toHaveBeenCalledWith({ conversationId: 'session-1', itemId: 'agent-question:q1', kind: 'question', answers: [{ selected: ['提前'] }], by: 'desktop' })
    expect(remote).not.toHaveBeenCalled()
  })

  it('a session on another machine is answered there', async () => {
    stored = { ...card, deviceId: 'device-far' }
    await answerIfQuestionReply(reply('先不动'), 'owner-1')
    expect(remote).toHaveBeenCalledWith('device-far', expect.objectContaining({ answers: [{ selected: ['先不动'] }] }))
  })

  it('not asked of the sender, a card of several parts, or not a question card: nothing is answered', async () => {
    await answerIfQuestionReply(reply('提前'), 'colleague-1')
    stored = { ...card, options: [] }
    await answerIfQuestionReply(reply('提前'), 'owner-1')
    expect(local).not.toHaveBeenCalled()
    await answerIfQuestionReply(reply('好', '{"v":1,"type":"task","text":"登录页闪一下'), 'owner-1')
    await answerIfQuestionReply(reply('好', null), 'owner-1')
    expect(reads).toEqual(['card-msg', 'card-msg'])
  })

  it('reads back what a settled question was answered with', () => {
    expect(questionAnsweredText(JSON.stringify([{ selected: ['提前'] }]))).toBe('提前')
    expect(questionAnsweredText(JSON.stringify([{ selected: [], other: '先发我看' }]))).toBe('先发我看')
    expect(questionAnsweredText(null)).toBe('')
  })
})
