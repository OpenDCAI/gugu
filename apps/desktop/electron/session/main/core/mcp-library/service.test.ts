import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('@main/db/kv', () => ({
  KV: class {
    constructor(private readonly namespace: string) {}
    async get(key: string) {
      return store.get(`${this.namespace}:${key}`) ?? null;
    }
    async setOrThrow(key: string, value: unknown) {
      store.set(`${this.namespace}:${key}`, structuredClone(value));
    }
  },
}));
vi.mock('@main/worker-manifest', () => ({ guguMcpStdioRelayEntryPath: () => '/app/dist-electron/runtime/gugu-mcp-stdio-relay.mjs' }));
const listForAgent = vi.fn();
vi.mock('../mcp/services/McpService', () => ({ mcpService: { listForAgent: (...args: unknown[]) => listForAgent(...args) } }));
const checkLibraryMcp = vi.fn();
vi.mock('./check', () => ({ checkLibraryMcp: (...args: unknown[]) => checkLibraryMcp(...args) }));

const { McpLibraryService, planLibraryMcpDelivery } = await import('./service');

const echo = (name: string, enabledByDefault = true) =>
  ({ name, transport: 'stdio' as const, command: 'node', args: ['echo.mjs', name], enabledByDefault });

describe('McpLibraryService', () => {
  let service: InstanceType<typeof McpLibraryService>;
  beforeEach(() => {
    store.clear();
    listForAgent.mockReset();
    checkLibraryMcp.mockReset();
    service = new McpLibraryService();
  });

  it('加、改、删、默认启用;同名的整批不加', async () => {
    await service.add([echo('a'), echo('b', false)]);
    await expect(service.add([echo('c'), echo('a')])).rejects.toThrow(/already in the library: a/);
    expect((await service.list()).map((server) => server.name)).toEqual(['a', 'b']);

    await service.setEnabledByDefault('b', true);
    await service.update({ ...echo('a'), args: ['echo.mjs', 'changed'] });
    await service.remove('b');
    expect(await service.list()).toEqual([{ ...echo('a'), args: ['echo.mjs', 'changed'] }]);
    await expect(service.remove('nope')).rejects.toThrow(/not in the library/);
  });

  it('撞名的不收:保留名(咕咕自己每条任务都送的)、名字只差标点、同一个 URL', async () => {
    await expect(service.add([echo('gugu')])).rejects.toThrow(/reserved-name/);
    await service.add([echo('a-b'), { name: 'remote', transport: 'http', url: 'https://x.test/mcp', enabledByDefault: true }]);
    await expect(service.add([echo('a_b')])).rejects.toThrow(/same-env-suffix with 'a-b'/);
    await expect(service.add([{ name: 'remote-2', transport: 'http', url: 'https://x.test/mcp', enabledByDefault: true }])).rejects.toThrow(/same-url with 'remote'/);
    expect((await service.list()).map((server) => server.name)).toEqual(['a-b', 'remote']);
  });

  it('检测结果记回那条记录;改了配置,旧的检测结果就去掉', async () => {
    await service.add([echo('a')]);
    checkLibraryMcp.mockResolvedValue({ status: 'ok', at: 't', tools: [{ name: 'x' }] });
    await service.check('a');
    expect((await service.list())[0]!.check).toEqual({ status: 'ok', at: 't', tools: [{ name: 'x' }] });

    await service.update({ ...echo('a'), command: 'deno' });
    expect((await service.list())[0]!.check).toBeUndefined();
  });

  it('检测跑着的时候那台被改了:结果不记回去(那是另一份配置的读数)', async () => {
    await service.add([echo('a')]);
    checkLibraryMcp.mockImplementation(async () => {
      await service.update({ ...echo('a'), command: 'deno' });
      return { status: 'ok', at: 't', tools: [] };
    });
    await service.check('a');
    expect((await service.list())[0]!.check).toBeUndefined();
  });

  it('存着的读不懂就抛,❌ 当成空表(下一次保存会把列表整个盖掉)', async () => {
    store.set('mcp-library:servers', [{ name: 'broken', transport: 'stdio', enabledByDefault: true }]);
    await expect(service.list()).rejects.toThrow();
  });

  it('各家自己的那几台:用户级配置里的,咕咕自己写进去的不算;检测照那份配置起、不记下来', async () => {
    listForAgent.mockImplementation(async (providerId: string) => providerId === 'claude'
      ? [
          { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], providers: ['claude'] },
          { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', providers: ['claude'] },
        ]
      : [{ name: 'relayed', transport: 'stdio', command: '/app/gugu', args: ['/old/path/gugu-mcp-stdio-relay.mjs'], providers: ['antigravity'] }]);
    expect(await service.harnessServers(['claude', 'antigravity'])).toEqual([
      { providerId: 'claude', server: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
    ]);
    checkLibraryMcp.mockResolvedValue({ status: 'ok', at: 't', tools: [] });
    await service.checkHarnessServer('claude', 'context7');
    expect(checkLibraryMcp).toHaveBeenCalledWith(expect.objectContaining({ name: 'context7', command: 'npx' }));
    expect(store.get('mcp-library:servers')).toBeUndefined();
    await expect(service.checkHarnessServer('claude', 'gugu')).rejects.toThrow(/not in claude's own config/);
  });

  it('按名字取一条任务选中的那几台;列表里没有了的原样报回来', async () => {
    await service.add([echo('a'), echo('b')]);
    expect(await service.selected(['b', 'gone'])).toEqual({ servers: [echo('b')], missing: ['gone'] });
  });
});

describe('planLibraryMcpDelivery —— 勾了的那几台哪几台送、哪几台为什么留在外面', () => {
  const lib = [echo('a'), { name: 'h', transport: 'http' as const, url: 'https://x.test/mcp', enabledByDefault: true }, echo('mine')];
  it('这条腿收不到:一台都不送,每台写「收不到」;资源库里已删的写「已删」', () => {
    expect(planLibraryMcpDelivery({ servers: lib, missing: ['gone'], delivery: { channel: false }, own: new Set() })).toEqual({
      servers: [],
      leftOut: [{ name: 'gone', reason: 'missing' }, { name: 'a', reason: 'no-channel' }, { name: 'h', reason: 'no-channel' }, { name: 'mine', reason: 'no-channel' }],
    });
  });
  it('只收 http:stdio 那几台写「只收 http」;这一家自己有同名的写「让给它自己的」', () => {
    expect(planLibraryMcpDelivery({ servers: lib, missing: [], delivery: { channel: true, transports: ['http'] }, own: new Set(['mine']) })).toEqual({
      servers: [lib[1]],
      leftOut: [{ name: 'a', reason: 'no-stdio' }, { name: 'mine', reason: 'no-stdio' }],
    });
    expect(planLibraryMcpDelivery({ servers: lib, missing: [], delivery: { channel: true, transports: ['stdio', 'http'] }, own: new Set(['mine']) })).toEqual({
      servers: [lib[0], lib[1]],
      leftOut: [{ name: 'mine', reason: 'shadowed' }],
    });
  });
});
