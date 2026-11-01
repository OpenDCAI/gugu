import { describe, it } from 'vitest';
import { ownerCases } from './sessionLife/owner-cases';

describe('session lifecycle owner', () => {
  for (const c of ownerCases) it(c.name, c.run);
});
