import { describe, expect, it } from 'vitest'
import type { Settlement, SettlementQuestion } from '@gugu/session-core/session-record/contract'
import { agentQuestionDraftKey, latestAgentQuestion, questionAnswerReady } from '../../../../apps/desktop/src/lib/agentQuestion'

const question: SettlementQuestion = { question: '预算？', multiSelect: false, options: [{ optionId: '300', name: '300 元' }] }
const settlement = (id: string, state: Settlement['state']): Settlement => ({ itemId: id, kind: 'question', questions: [question], state, optionId: null, resolvedBy: null, resolvedAt: null })

describe('agent question selection', () => {
  it('isolates answers by owner, session and question generation', () => {
    const asked = settlement('same', 'pending')
    const first = agentQuestionDraftKey('owner:a', asked)
    expect(first).not.toBe(agentQuestionDraftKey('another:a', asked))
    expect(first).not.toBe(agentQuestionDraftKey('owner:b', asked))
    expect(first).not.toBe(agentQuestionDraftKey('owner:a', { ...asked, askedAt: 2 }))
    expect(first).not.toBe(agentQuestionDraftKey('owner:a', { ...asked, questions: [{ ...question, question: '新的预算？' }] }))
  })

  it('never treats an empty or stale answer as consent', () => {
    expect(questionAnswerReady(question, { selected: [] }, false)).toBe(false)
    expect(questionAnswerReady(question, { selected: [], other: '  ' }, true)).toBe(false)
    expect(questionAnswerReady(question, { selected: ['old choice'] }, false)).toBe(false)
    expect(questionAnswerReady(question, { selected: [], other: '预算 500 元' }, true)).toBe(true)
    expect(questionAnswerReady(question, { selected: ['300'] }, false)).toBe(true)
  })

  it('keeps pending questions and removes settled receipts from the composer', () => {
    const old = settlement('old', 'pending'), receipt = settlement('new', 'resolved')
    expect(latestAgentQuestion({ old, receipt })?.itemId).toBe('old')
    expect(latestAgentQuestion({ old: { ...old, state: 'resolved' }, receipt })).toBeNull()
  })

  it('does not fabricate an answerable card when the host has no question channel', () => {
    expect(latestAgentQuestion({ unsupported: { ...settlement('unsupported', 'pending'), questions: undefined } })).toBeNull()
  })
})
