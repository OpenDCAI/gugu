import { describe, expect, it } from 'vitest';
import { providerCustomConfigEntrySchema } from './schema';

describe('providerCustomConfigEntrySchema', () => {
  it.each([
    { name: 'known fields', input: { extraArgs: '--verbose', env: { MY_KEY: 'value' } }, expected: { extraArgs: '--verbose', env: { MY_KEY: 'value' } } },
    { name: 'absent fields', input: {}, expected: {} },
    { name: 'legacy fields', input: { cli: 'claude', path: '/usr/local/bin/claude', installSource: 'path' }, expected: {} },
  ])('parses $name', ({ input, expected }) => {
    expect(providerCustomConfigEntrySchema.parse(input)).toEqual(expected);
  });
});
