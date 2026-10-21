import { describe, expect, it } from 'vitest'
import {
  buildExtensionEnvelope,
  mergeDeliveryEnvelopes,
} from '../../../../packages/core/src/local/agent/deliveryEnvelope'

// #6387 扩展把用户在它界面里的交互转成消息:壳还是那唯一一个 producer 出的,
// 写明来自哪个扩展(扩展 ❌ 冒充人或别的 agent)。只有一种语义:集体记忆对账第 12 条删了「附带」那一档。
describe('extension delivery envelope', () => {
  const base = {
    extensionId: 'agent-notes',
    extensionName: '随手记',
    messageId: '00000000-0000-4000-8000-000000000001',
    content: '选中了第 3 篇',
    at: '2026-09-24 18:00 UTC-7',
  }

  it('names the extension and tells the agent its reply is read by the person, not sent back', () => {
    const envelope = buildExtensionEnvelope(base)
    expect(envelope).toMatch(/^<gugu_delivery route="extension" from="随手记" from_id="extension:agent-notes" msg="msg:00000000-0000-4000-8000-000000000001"/)
    expect(envelope).toContain('<![CDATA[选中了第 3 篇]]>')
    expect(envelope).toContain('the person reads what you print here')
    // 扩展没有回程工具:❌ 叫 agent 用 session_message / message_send 回。
    expect(envelope).not.toMatch(/session_message|message_send/)
    expect(envelope).not.toContain('mode=')
  })

  it('merges with other deliveries through the single merge owner, keeping each sender', () => {
    const merged = mergeDeliveryEnvelopes([
      buildExtensionEnvelope(base),
      buildExtensionEnvelope({ ...base, extensionName: '论文台', extensionId: 'paper-desk' }),
    ])
    expect(merged).toMatch(/^<gugu_deliveries count="2"/)
    expect(merged).toContain('from="随手记"')
    expect(merged).toContain('from="论文台"')
  })
})
