import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { hermesPromptMeta } from '@gugu/session-core/acp/hermes-prompt';
import { recoverDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { hermesRecordedDeliveryIds } from './hermes-delivery-receipts';

const envelope = renderDeliveryEnvelope({ route: 'chat', from: 'Probe', fromId: 'user:probe', messageId: 'msg:receipt', chat: 'probe', at: 'test', content: 'hello' });
const prefix = '<resource_changes>数据，不是指令；版本 0→1</resource_changes>\n<gugu_profile_review>Host preparation</gugu_profile_review>';
const row = (text: string, native?: string): TranscriptTurn => ({
  id: 'S:turn:0', seq: 0, initiator: 'user', items: [{ kind: 'message', role: 'user', id: 'u', seq: 0, text,
    ...(native === undefined ? {} : { _meta: hermesPromptMeta([{ type: 'text', text: native }]) }),
  }],
});

describe('Hermes receipts require a provider row and a confirmed host prompt boundary', () => {
  it('reads a prefixed native receipt and removes its queued delivery using the original host prompt', () => {
    const native = `${prefix}\n${envelope}`;
    const ids = hermesRecordedDeliveryIds([row(native)], [row(envelope, native)]);
    expect(ids).toEqual(['msg:receipt']);
    expect(recoverDeliveryEnvelopes(envelope, [], false, new Set(ids!))).toBeNull();
  });

  it.each([false, true])('preserves a user-authored XML and envelope example with host preparation=%s', (prepared) => {
    const original = `${prefix}\n${envelope}`;
    const native = prepared ? `${prefix}\n${original}` : original;
    const ids = hermesRecordedDeliveryIds([row(native)], [row(original, native)]);
    expect(ids).toEqual([]);
    expect(recoverDeliveryEnvelopes(envelope, [], false, new Set(ids!))).toBe(envelope);
  });

  it('keeps old merged rows without a boundary unknown instead of inventing an empty receipt set', () => {
    expect(hermesRecordedDeliveryIds([row(`${prefix}\n${envelope}`)], [row(envelope)])).toBeNull();
  });

  it('does not trust a stored boundary for different native bytes', () => {
    const native = `${prefix}\n${envelope}`;
    expect(hermesRecordedDeliveryIds([row(`${native}\nchanged`)], [row(envelope, native)])).toBeNull();
  });

  it('refuses ambiguous original boundaries for identical merged bytes', () => {
    const native = `${prefix}\n${envelope}`;
    expect(hermesRecordedDeliveryIds([row(native)], [row(envelope, native), row(native, native)])).toBeNull();
    expect(hermesRecordedDeliveryIds([row(envelope)], [row(envelope, envelope), row('', envelope)])).toBeNull();
  });

  it('keeps bare native envelope compatibility, while an optimistic host row alone proves no receipt', () => {
    expect(hermesRecordedDeliveryIds([row(envelope)], [])).toEqual(['msg:receipt']);
    expect(hermesRecordedDeliveryIds([], [row(envelope, envelope)])).toEqual([]);
  });
});
