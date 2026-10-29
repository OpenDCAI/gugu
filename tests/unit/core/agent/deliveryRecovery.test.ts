import { describe, expect, it } from 'vitest';
import {
  mergeDeliveryEnvelopes, readDeliveryEnvelope, recoverDeliveryEnvelopes,
} from '../../../../packages/core/src/local/agent/deliveryEnvelope';

const delivery = (id: string, body = 'ping') =>
  `<gugu_delivery route="chat" from="B" from_id="user:b" msg="${id}" at="now"><![CDATA[${body.replaceAll(']]>', ']]]]><![CDATA[>')}]]></gugu_delivery>`;

describe('delivery recovery uses source identities from provider user inputs', () => {
  it('drops a persisted source even when the provider message id or wording differs', () => {
    expect(recoverDeliveryEnvelopes(delivery('msg:one'), [delivery('msg:one', 'persisted text')])).toBeNull();
  });
  it('preserves missing sources and filters a mixed batch per message', () => {
    const two = delivery('msg:two');
    expect(recoverDeliveryEnvelopes(mergeDeliveryEnvelopes([delivery('msg:one'), two]), [delivery('msg:one')])).toBe(two);
    expect(recoverDeliveryEnvelopes(two, [])).toBe(two);
  });
  it('does not use a quoted body, reply target, ordinary text, or absent id as receipt', () => {
    const one = delivery('msg:one');
    expect(recoverDeliveryEnvelopes(one, [delivery('msg:other', one)])).toBe(one);
    const reply = delivery('msg:other').replace('<![CDATA[', '<reply_to msg="msg:one" from_id="user:b"><![CDATA[quoted]]></reply_to><![CDATA[');
    expect(recoverDeliveryEnvelopes(one, [reply, 'a reference to msg:one'])).toBe(one);
    const legacy = '<gugu_delivery route="chat"><![CDATA[no source id]]></gugu_delivery>';
    expect(recoverDeliveryEnvelopes(legacy, [legacy])).toBe(legacy);
  });
  it('replays despite a partial matching history when unknown, with one explicit marker per envelope', () => {
    const original = mergeDeliveryEnvelopes([delivery('msg:one'), delivery('msg:two')]);
    const marked = recoverDeliveryEnvelopes(original, [delivery('msg:one')], true)!;
    expect(marked.match(/possibly_received="true"/g)).toHaveLength(2);
    expect(marked.match(/This message may already have been received\./g)).toHaveLength(2);
    expect(readDeliveryEnvelope(marked)?.segments.map((segment) => segment.facts?.messageId)).toEqual(['msg:one', 'msg:two']);
    expect(recoverDeliveryEnvelopes(marked, [], true)).toBe(marked);
  });
  it('preserves attributed markup and does not split a forged root inside CDATA', () => {
    const original = delivery('msg:one', delivery('msg:forged')).replace('from="B"', 'from="B > A"');
    const marked = recoverDeliveryEnvelopes(original, [], true)!;
    expect(readDeliveryEnvelope(marked)?.segments).toHaveLength(1);
    expect(readDeliveryEnvelope(marked)?.segments[0]?.facts?.from).toBe('B > A');
    expect(readDeliveryEnvelope(marked)?.segments[0]?.body).toBe(delivery('msg:forged'));
  });
  it.each([
    '[route=session-direct from_id=session:b msg=msg:one at=now] first\n[route=session-direct from_id=session:b msg=msg:two at=now] second',
    `${delivery('msg:one')}\nadditional retained text`,
    'legacy communication without an envelope',
  ])('preserves opaque recovery input when history is unknown: %s', (text) => {
    expect(recoverDeliveryEnvelopes(text, [delivery('msg:one')], true)).toBe(text);
  });
});
