import { expect, it } from 'vitest'
import { assistantGuide } from '../../../../packages/core/src/shared/assistantPolicy'

// 10-28: a key or token is typed in by the person on the connection page, never handed over in a chat.
it('tells the assistant never to ask for a key or token in the conversation, wherever it lives', () => {
  for (const kind of ['cloud', 'computer'] as const) {
    expect(assistantGuide(kind)).toContain('连接要的 key、token 由人自己在连接页填，❌ 在对话里向人要')
  }
})
