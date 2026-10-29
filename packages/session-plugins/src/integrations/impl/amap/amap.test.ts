import { describe, expect, it } from 'vitest';
import { integrationPluginRegistry } from '../../registry';
import { AMAP_KEY_GUIDE_URL, AMAP_MCP_URL } from '.';

describe('AMap (#921)', () => {
  it('connects with a key the platform keeps; AMap’s own address is there only for an installation with no platform service', () => {
    const plugin = integrationPluginRegistry.get('amap');
    const methods = plugin?.capabilities.auth.methods ?? [];
    expect(methods).toHaveLength(1);
    const [method] = methods;
    expect(method).toMatchObject({ kind: 'form', custody: 'platform', helpUrl: AMAP_KEY_GUIDE_URL });
    if (method?.kind !== 'form') return;
    expect(method.fields.map((field) => [field.id, field.secret])).toEqual([['apiKey', true]]);
    // The fallback where the key stays on this computer: it builds AMap's address and checks the key itself.
    expect(method.mcp).toMatchObject({ serverUrl: AMAP_MCP_URL, keyField: 'apiKey', keyQueryParam: 'key' });
    expect(plugin?.behavior.auth?.verify).toBeTypeOf('function');
  });
});
