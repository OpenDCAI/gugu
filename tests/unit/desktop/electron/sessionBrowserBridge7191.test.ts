import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  PLAYWRIGHT_CONFIG,
  closeSessionBrowserTools,
  SessionBrowserTools,
  agentVisibleTools,
  answeredLocally,
  browserToolsClient,
  createBrowserAppProgram,
} from '../../../../apps/desktop/electron/browser-agent-mcp'

/**
 * #7191 会话的 agent 拿到的浏览器工具:是哪一份、给谁、提示里怎么说。
 * 工具本身是 `@playwright/mcp` 原样的整套 —— 这里读的是它真实给出的清单,❌ 手抄一份名单来比。
 */

async function playwrightToolNames(): Promise<string[]> {
  const { createConnection } = createRequire(import.meta.url)('@playwright/mcp') as {
    createConnection: (config: object, contextGetter: () => Promise<unknown>) => Promise<{ connect(t: unknown): Promise<void>; close(): Promise<void> }>
  }
  // 列工具不碰浏览器:真去连就说明「列一下工具就给会话开页签」,这里当场响亮。
  const server = await createConnection(PLAYWRIGHT_CONFIG, async () => {
    throw new Error('listing tools must not open a browser tab')
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('#7191 交给 agent 的 Playwright 工具', () => {
  it('#7323 the default blank start page cannot bootstrap non-navigation, while explicit navigation can', async () => {
    const bridge = { openTransport: vi.fn(async () => { throw new Error('no page'); }), toolStarting: () => ({ ok: true as const }),
      toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: async () => null };
    const provider = createBrowserAppProgram(() => bridge);
    const program = { extensionId: 'browser-use', server: 'browser-use', native: 'browser-use' as const,
      digest: 'd', command: 'Gugu Browser Use', args: [], env: { GUGU_APP_SETTINGS: '{"startUrl":"about:blank"}' }, cwd: '/tmp', dataDir: '/tmp' };
    const sid = randomUUID();
    try {
      await provider.call(program, { name: 'browser_snapshot', _meta: { 'gugu/sessionId': sid } }, new AbortController().signal);
      expect(bridge.openTransport).toHaveBeenCalled();
      expect(bridge.setInitialUrl).not.toHaveBeenCalledWith(sid, 'about:blank');
      await provider.call(program, { name: 'browser_navigate', arguments: { url: 'about:blank' }, _meta: { 'gugu/sessionId': randomUUID() } }, new AbortController().signal);
      expect(bridge.setInitialUrl).toHaveBeenCalledWith(expect.any(String), 'about:blank');
    } finally { await provider.retire('browser-use'); }
  });
  it('the Browser Use App lists real schemas without opening a page and refuses calls with no session or a human takeover', async () => {
    const bridge = { openTransport: vi.fn(), toolStarting: vi.fn(() => ({ ok: false as const, message: 'human took over' })),
      toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: vi.fn(async () => null), states: () => [] };
    const provider = createBrowserAppProgram(() => bridge);
    const program = { extensionId: 'browser-use', server: 'browser-use', native: 'browser-use' as const,
      digest: 'd', command: 'Gugu Browser Use', args: [], env: { GUGU_APP_SETTINGS: '{"startUrl":"https://example.com"}' }, cwd: '/tmp', dataDir: '/tmp' };
    const listed = await provider.tools();
    expect(listed.map((tool) => tool.name)).toEqual(expect.arrayContaining(['browser_click', 'browser_navigate', 'browser_snapshot']));
    expect(listed.some((tool) => tool.name === 'browser_run_code_unsafe')).toBe(false);
    expect(bridge.openTransport).not.toHaveBeenCalled();
    expect(await provider.call(program, { name: 'browser_snapshot' }, new AbortController().signal)).toMatchObject({ isError: true });
    expect(bridge.toolStarting).not.toHaveBeenCalled();
    const stopped = await provider.call(program, { name: 'browser_snapshot', _meta: { 'gugu/sessionId': 's1' } }, new AbortController().signal);
    expect(stopped).toMatchObject({ isError: true, content: [{ type: 'text', text: 'human took over' }] });
    expect(bridge.openTransport).not.toHaveBeenCalled();
    expect(bridge.setInitialUrl).not.toHaveBeenCalled();
    expect(provider.status('browser-use')).toEqual({ running: 0, sessions: [] });
    await provider.retire('browser-use');
  });
  it('能在咕咕主进程里跑任意代码的、开关多个页签的不给;操作页面的照常给', async () => {
    const all = await playwrightToolNames()
    // 阳控:这个版本真给出这两把(否则下面的「不给」什么也没证明;core-tabs 不在配置里也照样给出,实测)。
    expect(all).toEqual(expect.arrayContaining(['browser_run_code_unsafe', 'browser_tabs']))
    const visible = agentVisibleTools(all.map((name) => ({ name }))).map((tool) => tool.name)
    expect(visible).not.toContain('browser_run_code_unsafe')
    expect(visible).not.toContain('browser_tabs')
    expect(visible).toEqual(expect.arrayContaining(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot']))
    expect(visible).toHaveLength(all.length - 2)
  })

  it('点名调它也拒;browser_close 在这里应答、不关人的页签;别的照常转给 Playwright', () => {
    expect(answeredLocally('browser_run_code_unsafe')?.isError).toBe(true)
    expect(answeredLocally('browser_tabs')?.isError).toBe(true)
    const close = answeredLocally('browser_close')
    expect(close?.isError).toBeFalsy()
    expect(JSON.stringify(close?.content)).toContain('stays open')
    expect(answeredLocally('browser_click')).toBeNull()
  })
})

describe('#7191 agent 存成文件的截图、快照落在会话的工作目录', () => {
  // Playwright MCP 拿「客户端的第一个根目录」当工作目录(coreBundle 的 initializeServer → firstRootPath),
  // agent 给了文件名的输出按它落盘。这里用一台 MCP server 照它那样问一遍。
  async function rootsSeenBy(client: Client) {
    const server = new Server({ name: 'probe', version: '1.0.0' }, { capabilities: {} })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    await client.connect(clientSide)
    try {
      return (await server.listRoots()).roots
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('问根目录,答这条会话的工作目录', async () => {
    expect(await rootsSeenBy(browserToolsClient('/Users/someone/项目 a'))).toEqual([
      { uri: 'file:///Users/someone/%E9%A1%B9%E7%9B%AE%20a', name: 'session workspace' },
    ])
  })

  it('阴控:不声明根目录的客户端,Playwright 问不到(它就退回咕咕进程自己的工作目录)', async () => {
    await expect(rootsSeenBy(new Client({ name: 'plain', version: '1.0.0' }))).rejects.toThrow()
  })
})

describe('#7191 会话结束时还在开页签的那一次', () => {
  it('session shutdown closes its pending connection; the next message reconnects without a browser resume action', async () => {
    let finishOpening!: (transport: { close(): void }) => void
    let openSignal: AbortSignal | undefined
    const transport = { close: vi.fn() }
    const bridge = { openTransport: vi.fn((_id: string, signal?: AbortSignal) => {
      openSignal = signal
      return new Promise<{ close(): void }>(resolve => { finishOpening = resolve })
    }), toolStarting: () => ({ ok: true as const }), toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: async () => null }
    const provider = createBrowserAppProgram(() => bridge)
    const program = { extensionId: 'browser-cancel', server: 'browser-use', native: 'browser-use' as const,
      digest: 'd', command: 'Gugu Browser Use', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp' }
    const id = randomUUID()
    const stoppedTurn = new AbortController()
    try {
      const pending = provider.call(program, { name: 'browser_snapshot', _meta: { 'gugu/sessionId': id } }, stoppedTurn.signal)
      await vi.waitFor(() => expect(openSignal).toBeDefined())
      await closeSessionBrowserTools(id)
      stoppedTurn.abort()
      expect(await pending).toMatchObject({ isError: true })
      expect(openSignal?.aborted).toBe(true)
      finishOpening(transport)
      await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(1))
      bridge.openTransport.mockImplementationOnce(async () => { throw new Error('next message acquired the same page') })
      const next = await provider.call(program, { name: 'browser_snapshot', _meta: { 'gugu/sessionId': id } }, new AbortController().signal)
      expect(next).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('next message acquired the same page') }] })
      expect(bridge.openTransport).toHaveBeenCalledTimes(2)
    } finally {
      await provider.retire('browser-cancel')
    }
  })

  it('cancels A without closing a shared MCP connection or failing concurrent B', async () => {
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const server = new Server({ name: 'two-calls', version: '1' }, { capabilities: { tools: {} } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let finishA!: () => void, finishB!: () => void;
    server.setRequestHandler(CallToolRequestSchema, async request => {
      await new Promise<void>(resolve => { if (request.params.name === 'a') finishA = resolve; else finishB = resolve; });
      return { content: [{ type: 'text', text: request.params.name }] };
    });
    await server.connect(serverSide);
    const client = browserToolsClient('/tmp'); await client.connect(clientSide);
    const factory = vi.spyOn(SessionBrowserTools.prototype, 'client').mockImplementation(function (this: SessionBrowserTools) {
      // A real shared MCP connection; use the production close path to expose accidental teardown.
      Object.assign(this, { closeServer: () => client.close() });
      return Promise.resolve(client);
    });
    const bridge = { openTransport: vi.fn(), toolStarting: () => ({ ok: true as const }), toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: async () => null };
    const provider = createBrowserAppProgram(() => bridge), sid = randomUUID();
    const program = { extensionId: 'parallel-browser', server: 'browser-use', native: 'browser-use' as const,
      digest: 'd', command: 'Gugu Browser Use', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp' };
    const a = new AbortController();
    try {
      const pendingA = provider.call(program, { name: 'a', _meta: { 'gugu/sessionId': sid } }, a.signal);
      const pendingB = provider.call(program, { name: 'b', _meta: { 'gugu/sessionId': sid } }, new AbortController().signal);
      await vi.waitFor(() => { expect(finishA).toBeDefined(); expect(finishB).toBeDefined(); });
      a.abort();
      expect(await pendingA).toMatchObject({ isError: true });
      finishB();
      expect(await pendingB).toMatchObject({ content: [{ text: 'b' }] });
      expect(provider.status('parallel-browser').running).toBe(1);
      finishA();
    } finally { finishA?.(); finishB?.(); await provider.retire('parallel-browser'); factory.mockRestore(); await server.close(); }
  });

  it('作罢:开页签的那一步收到中止,开好的连接当场关掉,❌ 半截连上的一份留在页签上', async () => {
    let finishOpening!: (transport: { close(): void }) => void
    let openSignal: AbortSignal | undefined
    const transport = { closed: 0, close() { this.closed += 1 } }
    const tools = new SessionBrowserTools(randomUUID(), () => ({
      openTransport: (_sessionId, signal) => {
        openSignal = signal
        return new Promise((resolve) => { finishOpening = resolve })
      },
      toolStarting: () => ({ ok: true }),
      toolFinished: () => undefined,
      setInitialUrl: () => undefined,
      workspaceRoot: async () => null,
    }), () => undefined)

    const client = await tools.client()
    const call = client.callTool({ name: 'browser_snapshot', arguments: {} }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(openSignal).toBeDefined())
    await tools.close()
    expect(openSignal?.aborted).toBe(true)
    finishOpening(transport)
    await call
    expect(transport.closed).toBe(1)
    await expect(tools.client()).rejects.toThrow(/closed/)
  })
})
