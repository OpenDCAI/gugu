import { expect, it, vi } from 'vitest';
import { closeProgramResources, ownProgramResource } from './program-resource-lifetime';

it('starts every cleanup synchronously and waits for all of them when one fails', async () => {
  const gate = Promise.withResolvers<void>();
  const slow = vi.fn(() => gate.promise), bad = vi.fn(() => { throw new Error('cleanup failed'); });
  ownProgramResource(-1001, bad); ownProgramResource(-1001, slow);
  let finished = false;
  const closed = closeProgramResources(-1001).finally(() => { finished = true; });
  const failure = expect(closed).rejects.toThrow('did not close cleanly');
  expect(bad).toHaveBeenCalledTimes(1); expect(slow).toHaveBeenCalledTimes(1);
  await Promise.resolve(); expect(finished).toBe(false);
  gate.resolve(); await failure;
});
it('late release of an old batch cannot erase resources admitted after the close boundary', async () => {
  const old = vi.fn(), current = vi.fn(), other = vi.fn();
  const releaseOld = ownProgramResource(-1002, old);
  ownProgramResource(-1003, other);
  await closeProgramResources(-1002);
  ownProgramResource(-1002, current); releaseOld();
  await closeProgramResources(-1002);
  expect(current).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
  await closeProgramResources(-1003);
});
