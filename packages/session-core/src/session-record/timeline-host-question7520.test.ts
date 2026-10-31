import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createClaudeJsonlSource } from './sources/claude-jsonl'
import { createSessionTimeline } from './timeline'
import { questionAnswerError } from './question-answer'

describe('host-owned structured questions', () => {
  it('publishes questions without a terminal answer channel, and never revives a settled generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-question-7520-'))
    const project = join(root, 'project')
    await mkdir(project)
    const providerSessionId = 'f1b2c3d4-0000-4000-8000-000000000001'
    await copyFile(fileURLToPath(new URL('./__fixtures__/claude-session.jsonl', import.meta.url)), join(project, `${providerSessionId}.jsonl`))
    const timeline = await createSessionTimeline(createClaudeJsonlSource({ harness: 'claude', providerSessionId, roots: [root] }), { sessionId: 'host-question', answerableQuestions: false })
    try {
      const request = { itemId: 'host-question:one', kind: 'question' as const, title: '预算？', askedAt: 123,
        questions: [{ question: '预算？', options: [{ optionId: '300', name: '300 元' }], multiSelect: false }],
        options: [], origin: { source: 'agent-question' as const, payload: {} } }
      timeline.syncPendingRequests([request])
      const one = () => timeline.getSnapshot().settlements.find((entry) => entry.itemId === request.itemId)
      expect(one()).toMatchObject({ questions: request.questions, askedAt: 123, state: 'pending', host: { kind: 'agent-question', payload: {} } })
      expect(timeline.settle({ itemId: request.itemId, optionId: '300', by: 'desktop' }).ok).toBe(true)
      timeline.syncPendingRequests([request])
      expect(one()?.state).toBe('resolved')
      expect(timeline.settle({ itemId: request.itemId, optionId: '300', by: 'phone' }).ok).toBe(false)
    } finally { timeline.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects stale, missing, duplicate and multiple single-choice answers', () => {
    const questions = [{ question: '预算？', multiSelect: false, options: [{ optionId: '300', name: '300' }, { optionId: '500', name: '500' }] }]
    for (const answer of [[], [{ selected: [] }], [{ selected: ['stale'] }], [{ selected: ['300', '500'] }], [{ selected: ['300', '300'] }]]) expect(questionAnswerError(questions, answer)).not.toBeNull()
    expect(questionAnswerError(questions, [{ selected: [], other: '600 元' }])).toBeNull()
  })
})
