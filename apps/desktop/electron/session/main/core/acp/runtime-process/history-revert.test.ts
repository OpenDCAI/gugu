import { describe, expect, it, vi } from 'vitest';
import { createHistoryReverter } from './history-revert';

describe('synchronized conversation revert (#7304)', () => {
  const input = { sessionId: 's', anchor: 'native-turn' };
  function setup() {
    const deps = {
      boundary: vi.fn(async () => 2),
      revert: vi.fn(async () => ({ success: true, data: { providerSessionId: 'same-thread' } })),
      truncate: vi.fn(async () => {}),
      finish: vi.fn(async () => {}),
    };
    return { deps, revert: createHistoryReverter(deps) };
  }
  it('reopens admission only after both histories were updated', async () => {
    const { deps, revert } = setup();
    await revert(input);
    expect(deps.truncate).toHaveBeenCalledWith('s', 2);
    expect(deps.finish.mock.invocationCallOrder[0]).toBeGreaterThan(deps.truncate.mock.invocationCallOrder[0]!);
  });
  it('a failed cache save is retried without another native revert', async () => {
    const { deps, revert } = setup();
    deps.truncate.mockRejectedValueOnce(new Error('database busy'));
    await expect(revert(input)).rejects.toThrow('provider history was reverted');
    expect(deps.finish).not.toHaveBeenCalled();
    await expect(revert({ ...input, anchor: 'other-point' })).rejects.toThrow('previous');
    await revert(input);
    expect(deps.revert).toHaveBeenCalledTimes(1);
    expect(deps.truncate).toHaveBeenCalledTimes(2);
    expect(deps.finish).toHaveBeenCalledTimes(1);
  });
  it('a native refusal leaves the display history alone', async () => {
    const { deps, revert } = setup();
    deps.revert.mockResolvedValueOnce({ success: false, data: { providerSessionId: 'same-thread' } });
    expect((await revert(input)).success).toBe(false);
    expect(deps.truncate).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });
});
