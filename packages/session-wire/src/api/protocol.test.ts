import { describe, expect, it } from 'vitest';
import { isWireMessage } from './protocol';

describe('isWireMessage payload guards', () => {
  it('rejects null payloads that would break transport consumers', () => {
    expect(isWireMessage({ kind: 'update', topic: 't', update: null })).toBe(false);
    expect(isWireMessage({ kind: 'topic-error', topic: 't', error: null, retrying: false })).toBe(false);
    expect(isWireMessage({ kind: 'blob-error', channel: 'c', error: null })).toBe(false);
  });

  it('still accepts the well-formed shapes', () => {
    expect(isWireMessage({ kind: 'update', topic: 't', update: { generation: 1 } })).toBe(true);
    expect(isWireMessage({ kind: 'topic-error', topic: 't', error: { message: 'x' }, retrying: true })).toBe(true);
    expect(isWireMessage({ kind: 'blob-error', channel: 'c', error: { message: 'x' } })).toBe(true);
  });
});
