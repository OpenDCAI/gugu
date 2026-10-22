import { describe, expect, it } from 'vitest'
import { userMessage } from '@/mobile/agent-watch/thread-messages'

// gugu-dev#181 ⑨ 手机会话页:宿主替主人交来的回答(`<gugu_question_answer>`)是一句「回答了什么」,与桌面同一个读法;❌ 原样的 XML。
const block = (fact: object) => `<gugu_question_answer>\n${JSON.stringify(fact)}\n</gugu_question_answer>\nThe owner explicitly submitted these answers in Gugu.`
const textOf = (message: ReturnType<typeof userMessage>) => (message.content as Array<{ type: string; text?: string }>).map((part) => part.text).join('')

describe('the owner\'s answer in the phone transcript', () => {
  it('says what was answered', () => {
    const line = textOf(userMessage('u1', block({ question_id: 'q', state: 'answered', questions: ['README?'], answers: [{ selected: ['建'] }] })))
    expect(line).toContain('建')
    expect(line).not.toContain('gugu_question_answer')
  })

  it('a withdrawn question says so', () => {
    expect(textOf(userMessage('u2', block({ question_id: 'q', state: 'withdrawn', questions: ['README?'] })))).not.toContain('gugu_question_answer')
  })

  it('ordinary words stay as they are', () => {
    expect(textOf(userMessage('u3', '先不建'))).toBe('先不建')
  })
})
