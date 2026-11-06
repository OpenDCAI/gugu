import { expect, it, vi } from 'vitest';
import { withFixtureCleanup } from './fixture-failure';

it('reports the primary failure before entering asynchronous cleanup', async () => {
  let finishCleanup!: () => void, enteredCleanup!: () => void;
  const cleaning = new Promise<void>(resolve => { enteredCleanup = resolve; });
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const failure = new Error('Pipeline timed out');
  const result = withFixtureCleanup(() => 'first-paint', async () => { throw failure; }, async () => {
    enteredCleanup(); await cleanup;
  }).catch(error => error);
  try {
    await cleaning;
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('"phase":"first-paint","message":"Pipeline timed out"');
    finishCleanup();
    expect(await result).toBe(failure);
  } finally { finishCleanup(); await result; write.mockRestore(); }
});

it('retains both the original failure and an independent cleanup failure', async () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const primary = new Error('Pipeline timed out'), cleanup = new Error('helper did not close');
  try {
    const error = await withFixtureCleanup(() => 'first-paint', async () => { throw primary; }, async () => { throw cleanup; }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([primary, cleanup]);
    const output = write.mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('Pipeline timed out');
    expect(output).toContain('helper did not close');
  } finally { write.mockRestore(); }
});
