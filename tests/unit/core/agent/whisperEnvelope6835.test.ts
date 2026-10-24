import { describe, expect, it } from 'vitest'
import { buildAgentDeliveryEnvelope, readDeliveryEnvelope } from '../../../../packages/core/src/local/agent/deliveryEnvelope'

// #6835 悄悄话与 App 代发各是信封上的一格事实:谁对谁说的悄悄话、哪个 App 以当前用户的名义送来。
const input = {
  guguUserId: 'agent-1',
  chatId: '00000000-0000-4000-8000-000000000001',
  messageId: '00000000-0000-4000-8000-000000000002',
  senderUserId: 'human-1',
  content: 'psst',
  replyTo: null,
  threadRootId: null,
}
const identities = new Map([['human-1', { guguNumber: 7, displayName: 'Bob' }]])
const group = { publicId: 208920, name: 'S5', kind: 'group' as const }

describe('whisper and app facts on the delivery envelope (#6835)', () => {
  it('writes the whisper recipients as typed ids and the app id, and reads them back', () => {
    const envelope = buildAgentDeliveryEnvelope({ ...input, whisperTo: ['agent-1'], viaApp: 'app:werewolf' }, identities, group, 't')
    expect(envelope).toContain('whisper_to="user:agent-1"')
    expect(envelope).toContain('via_app="app:werewolf"')
    expect(readDeliveryEnvelope(envelope)?.segments[0]?.facts).toMatchObject({ whisperTo: 'user:agent-1', viaApp: 'app:werewolf', chatKind: 'group' })
  })

  it('leaves both cells out of an ordinary delivery', () => {
    const envelope = buildAgentDeliveryEnvelope({ ...input, whisperTo: null }, identities, group, 't')
    expect(envelope).not.toMatch(/whisper_to=|via_app=/)
    expect(readDeliveryEnvelope(envelope)?.segments[0]?.facts).toMatchObject({ whisperTo: null, viaApp: null })
  })

  // 会话直发那条本地合成行也带 is_whisper,那是传输细节,不是人说的悄悄话。
  it('does not mark a session-direct delivery as a whisper', () => {
    const envelope = buildAgentDeliveryEnvelope({ ...input, whisperTo: ['agent-1'] }, identities, group, 't', { kind: 'session-direct' })
    expect(envelope).not.toContain('whisper_to=')
  })
})
