import { describe, expect, it, vi } from 'vitest';
import { createRPCClient } from './rpc';

describe('rpc 客户端被当成值反射读取时不抛错', () => {
  const invoke = vi.fn(async (channel: string) => channel);
  const client = createRPCClient<Record<string, Record<string, () => unknown>>>(invoke);

  it('频道路径照旧拼出来', async () => {
    await expect(client.extensions.list()).resolves.toBe('extensions.list');
  });

  it('name / toString / 转字符串 / JSON 都像普通值,不发远程调用', () => {
    invoke.mockClear();
    const ns = client.extensions as unknown as { name: unknown; length: unknown };
    expect(typeof ns.name).toBe('string');
    expect(typeof ns.length).toBe('number');
    expect(() => `${client.extensions}`).not.toThrow();
    expect(() => String(client.extensions.list)).not.toThrow();
    expect(() => JSON.stringify({ api: client.extensions })).not.toThrow();
    expect(() => `${client}`).not.toThrow();
    expect((client as unknown as { then?: unknown }).then).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
