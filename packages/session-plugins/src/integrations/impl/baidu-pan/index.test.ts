import { describe, expect, it } from 'vitest';
import { provider, BAIDU_PAN_APP_FOLDER } from './index';
import { summary } from './summary';

describe('Baidu Netdisk connection metadata', () => {
  it('uses the platform pre-registered client and SSE without a bundled secret', () => {
    expect(provider.validate()).toEqual([]);
    expect(provider.capabilities.auth.methods).toMatchObject([{
      kind: 'mcp-oauth', serverUrl: 'https://mcp-pan.baidu.com/sse', transport: 'sse',
      registration: 'pre-registered', custody: 'platform',
    }]);
    expect(BAIDU_PAN_APP_FOLDER).toBe('/apps/咕咕');
    expect(JSON.stringify(provider.capabilities)).not.toContain('client_secret');
  });
  it('states the folder limit in both the card and authorization copy in both languages', () => {
    const method = provider.capabilities.auth.methods[0];
    if (method.kind !== 'mcp-oauth') throw new Error('expected browser authorization');
    expect(summary.description['zh-CN']).toContain('只能访问百度网盘里的「咕咕」文件夹');
    expect(summary.description.en).toContain('Only accesses');
    expect(method.help?.['zh-CN']).toContain('只能访问百度网盘里的「咕咕」文件夹');
    expect(method.help?.en).toContain('only access');
    expect(provider.metadata.playbooks?.[0].prompt['zh-CN']).toContain('/apps/咕咕');
  });
});
