import { describe, expect, it } from 'vitest';
import { reconnectDelayMs, secondsUntilRetry } from './remote-reconnect';

describe('reconnect 节奏(#6264,照 VS Code:0,5,5,10…,30)', () => {
  it('delay 表', () => {
    expect([1, 2, 3, 4, 8, 9, 10, 50].map(reconnectDelayMs)).toEqual([0, 5_000, 5_000, 10_000, 10_000, 30_000, 30_000, 30_000]);
  });

  it('倒计时向上取整;不在等待中就没有倒计时', () => {
    const now = 1_000_000;
    expect(secondsUntilRetry({ kind: 'waiting', attempt: 2, retryAt: now + 2_900 }, now)).toBe(3);
    expect(secondsUntilRetry({ kind: 'waiting', attempt: 2, retryAt: now - 10 }, now)).toBe(0);
    expect(secondsUntilRetry({ kind: 'connecting', attempt: 1 }, now)).toBeNull();
  });
});
