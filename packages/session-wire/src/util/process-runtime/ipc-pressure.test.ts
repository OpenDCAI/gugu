import { describe, expect, it, vi } from 'vitest';
import { createIpcPressureSender, messageBytes } from './ipc-pressure';

describe('IPC byte pressure', () => {
  it('accounts for escaped control characters and unpaired surrogates without serializing a second copy', () => {
    for (const text of ['a\n\u0000"\\中🙂', '\ud800', '\udc00']) {
      const value = { data: text };
      expect(messageBytes(value)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(value)));
    }
  });
  it('pauses producers at a byte budget and resumes only after sends complete', () => {
    const completions: Array<(error: Error | null) => void> = [];
    const pressure = vi.fn();
    const error = vi.fn();
    const sender = createIpcPressureSender(
      (_message, callback) => {
        completions.push(callback);
        return true;
      },
      error,
      pressure,
      1024,
    );
    for (let n = 0; n < 4; n++) sender.send({ data: 'x'.repeat(256) });
    expect(pressure.mock.calls).toEqual([[true]]);
    expect(sender.pendingBytes).toBeLessThan(2048);
    completions[0]!(null);
    expect(pressure.mock.calls).toEqual([[true]]);
    for (const complete of completions.slice(1)) complete(null);
    expect(pressure.mock.calls).toEqual([[true], [false]]);
    expect(sender.pendingBytes).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('handles a closed channel without leaking its pending-byte accounting', () => {
    const pressure = vi.fn();
    const error = vi.fn();
    let completion: (error: Error | null) => void = () => {};
    const sender = createIpcPressureSender(
      (_message, callback) => {
        completion = callback;
        return false;
      },
      error,
      pressure,
      128,
    );
    sender.send('x'.repeat(100));
    expect(pressure).toHaveBeenLastCalledWith(true);
    completion(new Error('closed'));
    expect(sender.pendingBytes).toBe(0);
    expect(pressure).toHaveBeenLastCalledWith(false);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'closed' }));
  });
  it('delivers a history reply with a 33 MiB inline image without a fatal message-size exception', () => {
    const completions: Array<(error: Error | null) => void> = [];
    const sent: unknown[] = [];
    const pressure = vi.fn();
    const error = vi.fn();
    const sender = createIpcPressureSender((message, done) => { sent.push(message); completions.push(done); return false; }, error, pressure);
    const reply = { kind: 'result', id: 'history', ok: true, value: { success: true, data: { turns: [{ image: { data: 'A'.repeat(33 * 1024 * 1024) } }] } } };
    expect(() => sender.send(reply)).not.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(reply);
    expect(sender.pendingBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(pressure).toHaveBeenLastCalledWith(true);
    completions[0]!(null);
    expect(sender.pendingBytes).toBe(0);
    expect(pressure).toHaveBeenLastCalledWith(false);
    expect(error).not.toHaveBeenCalled();
  });
});
