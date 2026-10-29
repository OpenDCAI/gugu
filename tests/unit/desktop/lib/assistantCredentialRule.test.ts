import { expect, it } from 'vitest'
import { assistantBrief } from '../../../../packages/core/src/shared/assistantPolicy'

// 10-28: a key or token is typed in by the person on the connection page, never handed over in a chat.
// It sits in the brief, the part every session loads; the handbook is only read on demand.
it('tells the assistant never to ask for a key or token in the conversation, in the part it always loads', () => {
  for (const kind of ['cloud', 'computer'] as const) {
    expect(assistantBrief(kind, '/assistant/.gugu-assistant-reference.md', '/assistant/memory')).toContain('key、token 只由人在连接页填，❌ 在对话里要')
  }
})
