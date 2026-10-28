import { describe, expect, it } from 'vitest';
import { toSerializedError } from './index';

// An ACP agent rejects a prompt with a JSON-RPC error object, not an Error. It used to serialize as "[object Object]":
// the host log kept nothing and the chat got a bare "Agent 本次回复出错" for a reply that had already been sent.
describe('toSerializedError', () => {
  it('keeps the sentence, code and data of a JSON-RPC error object', () => {
    expect(toSerializedError({ code: -32603, message: 'Internal error', data: { details: 'stream closed', retryable: false } })).toEqual({
      name: 'Unknown',
      message: 'stream closed',
      code: -32603,
      data: { details: 'stream closed', retryable: false },
    });
  });

  it('takes the sentence from data, else from message', () => {
    expect(toSerializedError({ code: -32603, data: { details: 'API Error: 529 overloaded' } }).message).toBe('API Error: 529 overloaded');
    expect(toSerializedError({ code: -32603, message: 'Internal error' }).message).toBe('Internal error');
  });

  it('describes an object without any message by its top-level primitive fields only', () => {
    const error = toSerializedError({ status: 503, nested: { token: 'never-logged' } });
    expect(error.message).toBe('{"status":503}');
    expect(JSON.stringify(error)).not.toContain('never-logged');
  });

  it('never reports "[object Object]"', () => {
    expect(toSerializedError({}).message).not.toBe('[object Object]');
    expect(toSerializedError({ code: 1 }).message).not.toBe('[object Object]');
  });

  it('keeps an Error and a primitive as before', () => {
    const error = Object.assign(new Error('boom'), { code: 'E_FAIL' });
    expect(toSerializedError(error)).toMatchObject({ name: 'Error', message: 'boom', code: 'E_FAIL' });
    expect(toSerializedError('plain text')).toEqual({ name: 'Unknown', message: 'plain text' });
    expect(toSerializedError(undefined)).toEqual({ name: 'Unknown', message: 'undefined' });
  });
});
