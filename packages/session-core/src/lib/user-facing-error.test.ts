import { describe, expect, it, vi } from 'vitest';
import { safeFailureLine } from './user-facing-error';

describe('safeFailureLine', () => {
  it('localizes the exact wire disconnection after removing the IPC wrapper', () => {
    const reconnect = vi.fn(() => '与机器的连接已断开');
    expect(safeFailureLine("Error invoking remote method 'history': Error: Wire transport disconnected\ncode=DISCONNECTED", reconnect)).toBe('与机器的连接已断开');
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('retains the actual cause while removing paths, tokens and subsequent lines', () => {
    const reconnect = vi.fn();
    expect(safeFailureLine('Error: Permission denied for /Users/alice/private.txt with sk-test_secret\nprivate stack', reconnect)).toBe('Permission denied for [path] with [redacted token]');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('keeps cancellation and provider errors as their own causes', () => {
    const reconnect = vi.fn();
    expect(safeFailureLine('Wire call cancelled', reconnect)).toBe('Wire call cancelled');
    expect(safeFailureLine('Provider refused this model', reconnect)).toBe('Provider refused this model');
    expect(reconnect).not.toHaveBeenCalled();
  });
});
