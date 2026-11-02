import { describe, expect, it, vi } from 'vitest';

vi.mock('./session-life', () => ({ sessionLife: () => { throw new Error('not used here'); } }));

import { bindIdentityThenCreate, claimIdentityCreation } from './session-life-creation';

describe('creation with an identity bound first', () => {
  it('binds, then creates; a failed row takes its binding back and the failure is raised', async () => {
    const trace: string[] = [];
    await expect(bindIdentityThenCreate(
      async () => { trace.push('bind'); },
      async () => { trace.push('create'); throw new Error('session insert failed'); },
      async () => { trace.push('unbind'); },
    )).rejects.toThrow('session insert failed');
    expect(trace).toEqual(['bind', 'create', 'unbind']);
  });

  it('a failed binding creates nothing', async () => {
    const create = vi.fn();
    await expect(bindIdentityThenCreate(async () => { throw new Error('identity refused'); }, create, vi.fn())).rejects.toThrow('identity refused');
    expect(create).not.toHaveBeenCalled();
  });

  it('a concurrent second create for the same identity fails loudly; another identity, or a later one, proceeds', () => {
    const release = claimIdentityCreation('agent-1');
    expect(() => claimIdentityCreation('agent-1')).toThrow(/already being created/);
    const other = claimIdentityCreation('agent-2');
    release(); other();
    claimIdentityCreation('agent-1')();
  });
});
