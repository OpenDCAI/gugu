import { describe, expect, it } from 'vitest';
import { confirmReasonFor, reloadReasonCodeFor, reloadRequestFor } from './pending-setting-restart';

describe('restart targets: one translation per dimension', () => {
  it('a permission switch carries the Gugu tier to the host, and only that', () => {
    const target = { dimension: 'permission', value: 'full-access', label: 'Full Access' } as const;
    expect(reloadRequestFor(target, 's1')).toEqual({ sessionId: 's1', reason: 'permission-switch', permissionMode: 'full-access' });
    expect(reloadReasonCodeFor(target)).toBe('permission-switch');
    expect(confirmReasonFor(target)).toBe('permission-switch');
  });

  it('a model switch still carries the model with its billing source', () => {
    const target = { dimension: 'model', value: 'glm-5.3', label: 'GLM-5.3', source: 'platform' } as const;
    expect(reloadRequestFor(target, 's1')).toEqual({ sessionId: 's1', reason: 'model-switch', model: 'glm-5.3', modelSource: 'platform' });
    expect(confirmReasonFor(target)).toBe('model-switch');
  });
});
