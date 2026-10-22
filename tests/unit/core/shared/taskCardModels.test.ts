import { describe, expect, test } from 'vitest'
import {
  composerCardPreview,
  parseComposerCard,
  serializeComposerCard,
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
