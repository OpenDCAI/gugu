import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { assertNoDeliveryEnvelopeInPersistedText } from './build-session-row';

/** #6822 「首句里有没有信封」与投递卡是同一个读方:真信封拒收,人打的话里提到这个词照常落库。 */
describe('chat-create first utterance', () => {
  it('rejects a delivery envelope', () => {
    const envelope = renderDeliveryEnvelope({ route: 'chat', from: 'Ada', fromId: 'user:ada', chat: '7', messageId: 'msg:1', at: 't', content: 'hi' });
    expect(() => assertNoDeliveryEnvelopeInPersistedText(envelope, 'origin.firstUtterance')).toThrow(/delivery envelope/);
  });

  it('keeps a person’s words that merely mention the tag', () => {
    expect(() =>
      assertNoDeliveryEnvelopeInPersistedText('为什么任务页里会露出 <gugu_delivery route="chat"> 这种标签?', 'origin.firstUtterance')
    ).not.toThrow();
  });
});
