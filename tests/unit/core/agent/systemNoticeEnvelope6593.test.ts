import { describe, expect, it } from 'vitest'
import {
  buildSystemNoticeEnvelope,
  mergeDeliveryEnvelopes,
} from '../../../../packages/core/src/local/agent/deliveryEnvelope'

// #6593 咕咕自己告诉一条会话的一件事:发信方是咕咕系统(与聊天里的系统消息同名同锚),不挂任何聊天,
// 也没有要回的人 ⇒ ❌ 叫 agent 用任何回程工具。
describe('system notice envelope', () => {
  const base = {
    messageId: '00000000-0000-4000-8000-000000006593',
    content: 'Your owner renamed you.',
    at: '2026-09-27 03:00 北京时间 (UTC+8)',
  }

  it('comes from 咕咕 itself, carries no chat, and names no return tool', () => {
    const envelope = buildSystemNoticeEnvelope(base)
    expect(envelope).toMatch(/^<gugu_delivery route="system" from="咕咕系统" from_id="system:gugu" msg="msg:00000000-0000-4000-8000-000000006593"/)
    expect(envelope).toContain('<![CDATA[Your owner renamed you.]]>')
    expect(envelope).toContain('not a request; there is no one to reply to')
    expect(envelope).not.toMatch(/ chat="| chat_kind="|session_message|message_send/)
  })

  it('merges with other deliveries through the single merge owner', () => {
    const merged = mergeDeliveryEnvelopes([buildSystemNoticeEnvelope(base), buildSystemNoticeEnvelope(base)])
    expect(merged).toMatch(/^<gugu_deliveries count="2"/)
  })
})
