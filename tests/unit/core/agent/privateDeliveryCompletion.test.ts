import { expect, it } from 'vitest'
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
it('tells an injected private turn to finish on its IM reply without another task summary', () => {
  const facts = { route: 'chat' as const, from: 'Owner', fromId: 'user:owner', messageId: 'msg:source', chat: 'chat', at: '', content: 'Hello' }
  expect(renderDeliveryEnvelope({ ...facts, chatKind: 'dm' })).toContain('without repeating the answer or adding a separate task summary')
  expect(renderDeliveryEnvelope({ ...facts, chatKind: 'group' })).not.toContain('separate task summary')
})
