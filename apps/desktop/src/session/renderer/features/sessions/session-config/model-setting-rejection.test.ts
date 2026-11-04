import { describe, expect, it } from 'vitest';
import { modelSettingRejection } from './model-setting-rejection';
import { toSerializedError } from '@gugu/session-shared';

describe('model setting rejection contract', () => {
  const data = { kind: 'model-unavailable' as const, requestedValue: 'retired-model' };
  it('survives the real error serialization and runtime cause wrapper', () => {
    const error = Object.assign(new Error('unknown model'), { code: -32602, data });
    expect(modelSettingRejection({ type: 'set_config_failed', cause: toSerializedError(error) })).toEqual(data);
  });
  it('does not infer retirement from unrelated messages or malformed data', () => {
    expect(modelSettingRejection(new Error('unknown model'))).toBeNull();
    expect(modelSettingRejection({ data: { ...data, requestedValue: 123 } })).toBeNull();
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(modelSettingRejection(cycle)).toBeNull();
  });
});
