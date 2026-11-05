import { describe, expect, it } from 'vitest';
import { unavailablePlatformModelId } from './platform-model-selection';

describe('unavailable model setting', () => {
  const catalog = { sessionSelection: { modelId: 'retired-model' }, models: [{ id: 'available-model' }], catalogError: null, settled: true };
  it('keeps the retired current model identifiable for in-place replacement', () => {
    expect(unavailablePlatformModelId(catalog)).toBe('retired-model');
  });
  it('does not call a failed or unfinished catalog a model retirement', () => {
    expect(unavailablePlatformModelId({ ...catalog, catalogError: 'host-not-ready' })).toBeNull();
    expect(unavailablePlatformModelId({ ...catalog, sessionSelection: undefined })).toBeNull();
    expect(unavailablePlatformModelId({ ...catalog, models: [], settled: false })).toBeNull();
  });
  it('leaves BYOK models independent from the platform catalog', () => {
    expect(unavailablePlatformModelId({ ...catalog, sessionSelection: null })).toBeNull();
  });
  it('clears the notice after an acknowledged live replacement, before record refresh', () => {
    expect(unavailablePlatformModelId({ ...catalog, liveModel: 'available-model' })).toBeNull();
  });
});
