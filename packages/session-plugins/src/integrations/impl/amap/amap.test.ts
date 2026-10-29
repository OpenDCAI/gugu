import { describe, expect, it } from 'vitest';
import { integrationPluginRegistry } from '../../registry';
import { AMAP_KEY_GUIDE_URL } from '.';

describe('AMap (#921)', () => {
  it('connects with a key the platform keeps: the plugin names its fields only, no upstream address or key placement', () => {
    const plugin = integrationPluginRegistry.get('amap');
    const methods = plugin?.capabilities.auth.methods ?? [];
    expect(methods).toHaveLength(1);
    const [method] = methods;
    expect(method).toMatchObject({ kind: 'form', custody: 'platform', helpUrl: AMAP_KEY_GUIDE_URL });
    if (method?.kind !== 'form') return;
    expect(method.fields.map((field) => [field.id, field.secret])).toEqual([['apiKey', true]]);
    expect(JSON.stringify(method)).not.toMatch(/mcp\.amap\.com|serverUrl|keyQueryParam|keyField/);
    // The platform checks the key when it is saved; the device has nothing to check it with.
    expect(plugin?.behavior.auth?.verify).toBeUndefined();
  });
});
