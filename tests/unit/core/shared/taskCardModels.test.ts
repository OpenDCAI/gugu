import { describe, expect, test } from 'vitest'
import {
  composerCardPreview,
  parseComposerCard,
  serializeComposerCard,
  type QuestionCard,
  type TaskCard,
} from '../../../../packages/core/src/shared/ui/taskCardModels'

const task: TaskCard = {
  v: 1,
  type: 'task',
  text: '登录页打开时闪一下，帮我看看为什么 "quoted" \\ done \u0001',
  agentUserId: 'agent-1',
  agentName: 'Claude 5',
  sessionId: 'session-1',
  projectId: 'project-1',
  deviceId: 'device-1',
  machineLabel: 'ThinkPad',
}

describe('task card (gugu-dev#181)', () => {
  test('round-trips, words first whatever order the caller built it in', () => {
    const shuffled = Object.fromEntries(Object.entries(task).reverse()) as unknown as TaskCard
    const raw = serializeComposerCard(shuffled)
    expect(raw.startsWith('{"v":1,"type":"task","text":')).toBe(true)
    expect(parseComposerCard(raw)).toEqual(task)
  })

  test('another card shape, or not JSON, is not a composer card', () => {
    expect(parseComposerCard('{"v":1,"type":"poll","text":"x"}')).toBeNull()
    expect(parseComposerCard(JSON.stringify({ ...task, projectId: '' }))).toBeNull()
    expect(parseComposerCard('not json')).toBeNull()
  })

  test('the cloud cut of a card (first 100 characters) still reads as the words', () => {
    const raw = serializeComposerCard(task)
    for (let cut = 30; cut <= raw.length; cut++) {
      const read = composerCardPreview(raw.slice(0, cut))
      expect(read?.type).toBe('task')
      expect(task.text.startsWith(read!.text)).toBe(true)
    }
    expect(composerCardPreview(raw.slice(0, 100))?.text).toBe(task.text)
  })

  test('ordinary text is left alone', () => {
    expect(composerCardPreview('hello')).toBeNull()
    expect(composerCardPreview('{"v":1,"type":"widget"}')).toBeNull()
  })
})

const question: QuestionCard = {
  v: 1,
  type: 'question',
  text: '要把初始化提前到登录之前吗？会动到 3 个文件。',
  options: ['提前', '先不动'],
  ownerUserId: 'owner-1',
  questionId: 'agent-question:3f1c7a52-0d55-4e0b-9a36-4f2f0a4c9a11',
  sessionId: 'session-1',
  projectId: 'project-1',
  deviceId: 'device-1',
  machineLabel: 'ThinkPad',
}

describe('question card (gugu-dev#181 ⑨)', () => {
  test('round-trips, and its cut reads as a question', () => {
    const raw = serializeComposerCard(question)
    expect(parseComposerCard(raw)).toEqual(question)
    expect(composerCardPreview(raw.slice(0, 100))).toEqual({ type: 'question', text: question.text })
  })

  test('one that does not say whom it asks, or which question, is not a card', () => {
    expect(parseComposerCard(JSON.stringify({ ...question, ownerUserId: '' }))).toBeNull()
    expect(parseComposerCard(JSON.stringify({ ...question, questionId: undefined }))).toBeNull()
    expect(parseComposerCard(JSON.stringify({ ...question, options: [1] }))).toBeNull()
  })
})
