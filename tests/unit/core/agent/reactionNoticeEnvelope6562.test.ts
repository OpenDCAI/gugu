import { describe, expect, it } from 'vitest'
import {
  arrivalHint,
  buildAgentDeliveryEnvelope,
  type GuguIdentity,
} from '../../../../packages/core/src/local/agent/deliveryEnvelope'
import { describeReactions, REACTIONS, QUICK_REACTIONS, reactionLabel } from '../../../../packages/core/src/shared/ui/reactionCatalog'

// #6562 人给 agent 的消息点 reaction ⇒ 库写一条无发送者的系统 whisper,正文只有表情;
// 信封把它标成通知(不是请求),名字从 picker 用的同一份目录补进 message_context。
const AGENT = '00000000-0000-4000-8000-00000000a6e7'
const HUMAN = '00000000-0000-4000-8000-0000000000a1'
const CHAT = '00000000-0000-4000-8000-00000000c4a7'
const NOTICE = `Alice(gugu:12) 对你的消息点了 👍\nmsg:00000000-0000-4000-8000-000000000001 「迁移推上去了」`

function envelope(senderUserId: string | null, content: string, contentType = 'system'): string {
  const identities = new Map<string, GuguIdentity>([[HUMAN, { guguNumber: 12, displayName: 'Alice' }]])
  return buildAgentDeliveryEnvelope(
    {
      guguUserId: AGENT,
      chatId: CHAT,
      messageId: '00000000-0000-4000-8000-000000000002',
      senderUserId,
      contentType,
      content,
      replyTo: null,
      threadRootId: null,
    },
    identities,
    { publicId: 207672, name: '需求群', kind: 'group' },
    '2026-09-26 19:00 北京时间',
  )
}

describe('#6562 reaction notice envelope', () => {
  it('marks a senderless system message as a notice, not a request, and names the reaction from the catalog', () => {
    const text = envelope(null, NOTICE)
    expect(text).toContain('from="咕咕系统" from_id="system:gugu"')
    expect(text).toContain(' mode="notice"')
    expect(text).toContain('<message_context><![CDATA[👍 = 赞 (Like)]]></message_context>')
    expect(text).toContain(`<arrival>${arrivalHint('chat', 'notice')}</arrival>`)
    expect(arrivalHint('chat', 'notice')).toContain('not a request')
    // 回程工具照写:要发言时不必再找路。
    expect(arrivalHint('chat', 'notice')).toContain('message_send')
    // 正文是库写的原样,❌ 被改写。
    expect(text).toContain(`<![CDATA[${NOTICE}]]>`)
  })

  it('a person\'s message keeps the ordinary arrival and gets no glossary, even with the same emoji in it', () => {
    const text = envelope(HUMAN, '👍 同意', 'text')
    expect(text).not.toContain('mode=')
    expect(text).not.toContain('<message_context>')
    expect(text).toContain('reply with message_send')
  })

  it('a system notice without catalog emoji is still a notice, with no empty context block', () => {
    const text = envelope(null, '这个群里 agent 较多,已把它们都转为被动模式,@ 它们才会回。')
    expect(text).toContain(' mode="notice"')
    expect(text).not.toContain('<message_context>')
  })
})

describe('#6562 reaction catalog', () => {
  it('describes every catalog emoji present, in catalog order, and nothing else', () => {
    expect(describeReactions('点了 🙏 和 👍,还有 🦄')).toBe('👍 = 赞 (Like)\n🙏 = 感谢 (Thanks)')
    expect(describeReactions('没有表情')).toBeUndefined()
  })

  it('derives the mixed six quick reactions without changing the status glossary', () => {
    expect(QUICK_REACTIONS.map(({ emoji }) => emoji)).toEqual(['👍', '❤️', '😂', '👀', '✅', '🙏'])
    expect(describeReactions('👌 👀 ⏳ ✅ ❓ ❌ 🦄')).toBe('👌 = 收到 (Got it)\n👀 = 在看 (On it)\n⏳ = 稍等 (One moment)\n✅ = 完成 (Done)\n❓ = 疑问 (Question)\n❌ = 不对 (No)')
  })

  it('labels by interface language and has no label for emoji outside the catalog', () => {
    expect(reactionLabel('👍', 'zh-CN')).toBe('赞')
    expect(reactionLabel('👍', 'en-US')).toBe('Like')
    expect(reactionLabel('🦄', 'zh-CN')).toBeNull()
  })

  it('keeps one entry per emoji', () => {
    expect(new Set(REACTIONS.map((reaction) => reaction.emoji)).size).toBe(REACTIONS.length)
  })
})
