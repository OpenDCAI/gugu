import { describe, expect, it } from 'vitest';
import { bridgeFailure } from './bridge-protocol';

/**
 * #7126: readAgentHistory's refusals reach the App with their code, so it tells 「看不到」 (`not-found`) from 「读不到」
 * (`unavailable`) and a bad cursor (`invalid`) — before this, every one of them crossed the bridge as `failed`, and
 * radar could only show gugu's English message to the person.
 */
describe('readAgentHistory refusals keep their code across the bridge (#7126)', () => {
  it.each(['not-found', 'unavailable', 'invalid'] as const)('%s', (code) => {
    expect(bridgeFailure(Object.assign(new Error('refused'), { code })).code).toBe(code);
  });

  it('control: an error without a known code is failed', () => {
    expect(bridgeFailure(new Error('refused')).code).toBe('failed');
    expect(bridgeFailure(Object.assign(new Error('refused'), { code: 'not-open' })).code).toBe('failed');
  });
});
