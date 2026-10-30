import { describe, expect, it, vi } from 'vitest';
import { createRPCClient, registerRPCRouter } from './rpc';

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

describe('registered routes are reachable through the real client', () => {
  function wire(router: Parameters<typeof registerRPCRouter>[0]) {
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>();
    registerRPCRouter(router, { handle: (channel, listener) => { handlers.set(channel, listener); } });
    return createRPCClient<Record<string, Record<string, (...args: unknown[]) => unknown>>>(async (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      return handler({ sender: { id: 1 } }, ...args);
    });
  }

  it('a client call reaches the handler with its arguments', async () => {
    const client = wire({ search: { write: (ops: unknown) => ['wrote', ops] } });
    await expect(client.search.write([1, 2])).resolves.toEqual(['wrote', [1, 2]]);
  });

  it.each(['apply', 'call', 'bind', 'name', 'length', 'toString', 'constructor', 'then', 'toJSON'])(
    'refuses to register a method named %s, which the client proxy would read instead of calling', (name) => {
      expect(() => wire({ search: { [name]: () => 'unreachable' } })).toThrow(/cannot be reached/);
    });

  it('refuses a namespace named like an object property', () => {
    expect(() => wire({ constructor: { list: () => [] } })).toThrow(/cannot be reached/);
  });
});
