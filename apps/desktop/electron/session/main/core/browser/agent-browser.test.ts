import { EventEmitter } from 'node:events';
import { withBrowserCall } from './browser-call-scope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../asks', () => import('../../../../../../../tests/support/ask-service'));
vi.mock('../asks/ask', () => import('../../../../../../../tests/support/ask-service'));

const emitted = vi.hoisted(() => [] as Array<{ browserId: string; state?: string; kind?: string; moveId?: number; x?: number; y?: number; target?: unknown }>);
const registry = vi.hoisted(() => ({
  observer: null as null | ((browserId: string) => boolean),
  browsers: [] as Array<{ browserId: string; webContents: unknown }>,
  preferred: undefined as string | undefined,
}));
vi.mock('@main/lib/events', () => ({ events: { emit: (_channel: unknown, payload: (typeof emitted)[number]) => emitted.push(payload) } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/core/sessions/session-orchestration', () => ({ openAgentBrowserPane: vi.fn() }));
vi.mock('./browser-page-runtime', () => ({ acquireBrowserPage: vi.fn() }));
vi.mock('./browser-webcontents-registry', () => ({
  browserWebContentsRegistry: {
    setMouseDownObserver: (fn: (browserId: string) => boolean) => {
      registry.observer = fn;
    },
    browsersOfSession: () => registry.browsers,
    preferredBrowserOfSession: () => registry.preferred,
  },
}));

// controller.ts 拉进来的这些依赖都绑着 Electron;下面「真实 RPC 层」那条用例只用 agent-browser 与 controller 本身。
vi.mock('@main/core/browser/browser-cookie-import', () => ({ defaultBrowser: vi.fn(), importDefaultBrowserCookies: vi.fn() }));
vi.mock('@main/core/browser/browser-profile-session', () => ({ configureBrowserProfileSession: vi.fn() }));
vi.mock('@main/core/browser/browser-page-views', () => ({}));
vi.mock('@main/core/browser/webview-security', () => ({ isBrowserPartition: vi.fn() }));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: {} }));

import {
  agentBrowserStateOf,
  agentBrowserToolFinished,
  agentBrowserToolStarting,
  agentCursorArrived,
  createPaneTransport,
  openAgentBrowserTransport,
  setAgentBrowserInitialUrl,
} from './agent-browser';
import { agentSessionContext } from '@main/core/extensions/extension-agent-context';
import { createRPCClient, registerRPCRouter, type RpcIpcMainLike } from '@shared/lib/ipc/rpc';
import { openAgentBrowserPane } from '@main/core/sessions/session-orchestration';
import { acquireBrowserPage } from './browser-page-runtime';

/** 网页的 webContents:只做 transport 碰得到的那几样。debugger 的每个命令都记下来。 */
function fakeGuest(id = 7) {
  const dbg = Object.assign(new EventEmitter(), {
    attached: false,
    commands: [] as Array<{ method: string; params: unknown; sessionId?: string }>,
    /** 网页里有焦点的输入框(主框架 CSS 像素),供「打字前鼠标落进去」查。 */
    focusedBox: null as number[] | null,
    frameTree: { frame: { id: 'T1', loaderId: 'L1', url: 'https://a.test/' } },
    documentUrl: 'about:blank',
    documentException: undefined as { text: string } | undefined,
    onDocumentLookup: undefined as (() => void) | undefined,
    detachCalls: 0,
    isAttached() {
      return this.attached;
    },
    attach() {
      this.attached = true;
    },
    detach() {
      this.detachCalls += 1;
      this.attached = false;
    },
    async sendCommand(method: string, params: unknown, sessionId?: string) {
      this.commands.push({ method, params, sessionId });
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'T1', type: 'webview', title: 'p', url: 'https://a.test/' } };
      if (method === 'Page.getFrameTree') return { frameTree: this.frameTree };
      if (method === 'Runtime.evaluate' && (params as { expression?: string }).expression === 'document.URL') {
        this.onDocumentLookup?.();
        return { result: { value: this.documentUrl }, exceptionDetails: this.documentException };
      }
      if (method === 'Runtime.evaluate') return { result: { value: this.focusedBox } };
      return { ok: method };
    },
  });
  // #7274 网页是窗口里独立的 view,没有宿主页面(hostWebContents 为 null):transport 一样都不该去碰宿主。
  const wc = Object.assign(new EventEmitter(), {
    id,
    debugger: dbg,
    getURL: () => 'https://a.test/',
    isLoading: () => false,
    navigationHistory: { getAllEntries: () => [], getActiveIndex: () => -1, removeEntryAtIndex: vi.fn() },
    hostWebContents: null,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    close: vi.fn(), destroy: vi.fn(),
    getUserAgent: () => 'UA',
    zoom: 1,
    getZoomFactor() {
      return this.zoom;
    },
  });
  return { wc, dbg };
}

function connect(sessionId: string, browserId: string, wc: unknown) {
  const transport = createPaneTransport(sessionId, browserId, wc as never);
  const received: any[] = [];
  const closes: Array<string | undefined> = [];
  transport.onmessage = (message) => received.push(message);
  transport.onclose = (reason) => closes.push(reason);
  let next = 1;
  const call = async (method: string, params: object = {}, sessionId?: string) => {
    const id = next++;
    transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    await vi.waitFor(() => expect(received.some((m) => m.id === id)).toBe(true));
    return received.find((m) => m.id === id);
  };
  return { transport, received, closes, call };
}

beforeEach(() => {
  vi.mocked(acquireBrowserPage).mockReset();
  emitted.length = 0;
  registry.browsers = [];
  registry.preferred = undefined;
});

describe('native rendering lifetime', () => {
  it('ends the page connection on its owning session signal without closing or locking the task page', async () => {
    const { wc, dbg } = fakeGuest();
    const controller = new AbortController();
    const transport = createPaneTransport('cancelled-tool', 'kept-page', wc as never, controller.signal);
    const closed = vi.fn();
    transport.onclose = closed;
    transport.send({ id: 1, method: 'Target.setAutoAttach' });
    await vi.waitFor(() => expect(dbg.attached).toBe(true));
    controller.abort();
    expect(closed).toHaveBeenCalledWith('the browser connection was cancelled');
    expect(wc.close).not.toHaveBeenCalled();
    expect(wc.destroy).not.toHaveBeenCalled();
    expect(dbg.detachCalls).toBe(1);
    const after = dbg.commands.length;
    transport.send({ id: 2, method: 'Input.insertText', params: { text: 'never' }, sessionId: 'gugu-agent-page' });
    await new Promise(done => setImmediate(done));
    expect(dbg.commands).toHaveLength(after);
    const next = connect('cancelled-tool', 'kept-page', wc);
    await expect(next.call('Target.setAutoAttach')).resolves.toHaveProperty('result');
    next.transport.close();
  });

  it('routes page captures through the owning runtime without changing CDP options', async () => {
    const lease = { ready: Promise.resolve(), setActive: vi.fn(), capture: vi.fn(async () => ({ data: 'native-image' })), dispose: vi.fn() };
    vi.mocked(acquireBrowserPage).mockReturnValueOnce(lease);
    const { wc, dbg } = fakeGuest();
    const { transport, call } = connect('native-capture', 'captured-page', wc);
    await call('Target.setAutoAttach');
    const params = { format: 'jpeg', quality: 60, captureBeyondViewport: true, clip: { x: 10, y: 20, width: 100, height: 200, scale: 0.5 } };
    expect(await call('Page.captureScreenshot', params, 'gugu-agent-page')).toMatchObject({ result: { data: 'native-image' } });
    expect(lease.capture).toHaveBeenCalledWith(params);
    expect(dbg.commands.some(command => command.method === 'Page.captureScreenshot')).toBe(false);
    transport.close();
  });

  it('does not attach CDP before the page surface is ready, and releases it on disconnect', async () => {
    let resolve!: () => void;
    const lease = { ready: new Promise<void>(done => { resolve = done; }), setActive: vi.fn(), capture: vi.fn(), dispose: vi.fn() };
    vi.mocked(acquireBrowserPage).mockReturnValueOnce(lease);
    const { wc, dbg } = fakeGuest();
    agentBrowserToolStarting('render-lifetime');
    const { transport, call } = connect('render-lifetime', 'render-page', wc);
    const pending = call('Target.setAutoAttach');
    await new Promise(done => setImmediate(done));
    expect(dbg.attached).toBe(false);
    expect(lease.setActive).toHaveBeenCalledWith(true);
    resolve();
    await pending;
    expect(dbg.attached).toBe(true);
    agentBrowserToolFinished('render-lifetime');
    transport.close();
    transport.close();
    expect(lease.dispose).toHaveBeenCalledOnce();
  });

  it('reports a surface failure without dispatching the command to another target', async () => {
    const lease = { ready: Promise.reject(new Error('surface failed')), setActive: vi.fn(), capture: vi.fn(), dispose: vi.fn() };
    vi.mocked(acquireBrowserPage).mockReturnValueOnce(lease);
    const { wc, dbg } = fakeGuest();
    const { transport, closes } = connect('render-failure', 'failed-page', wc);
    transport.send({ id: 1, method: 'Target.setAutoAttach' });
    // Listening now attaches before the first request; a failed viewport closes that connection.
    await vi.waitFor(() => expect(closes).toEqual(['surface failed']));
    expect(dbg.commands).toHaveLength(0);
    transport.close();
    expect(lease.dispose).toHaveBeenCalledOnce();
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#7323 reconnect resolves a persisted browser identity', () => {
  it.each(['surface failed', 'the page debugger is already in use'])('delivers early close %s when Playwright installs its handler later', async reason => {
    const { wc, dbg } = fakeGuest();
    if (reason === 'surface failed') {
      vi.mocked(acquireBrowserPage).mockReturnValueOnce({ ready: Promise.reject(new Error(reason)), setActive: vi.fn(), capture: vi.fn(), dispose: vi.fn() });
    } else dbg.attached = true;
    const transport = createPaneTransport('early-' + reason, 'early-page', wc as never);
    await new Promise<void>(resolve => setImmediate(resolve));
    const onclose = vi.fn();
    transport.onclose = onclose;
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledExactlyOnceWith(reason));
    transport.close();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('binds the exact tab acknowledged by the pane rather than the first live page', async () => {
    const other = fakeGuest(101);
    const original = fakeGuest(102);
    registry.browsers = [{ browserId: 'other', webContents: other.wc }, { browserId: 'original', webContents: original.wc }];
    registry.preferred = 'original';
    vi.mocked(agentSessionContext).mockResolvedValueOnce({ projectId: 'p' } as never);
    vi.mocked(openAgentBrowserPane).mockResolvedValueOnce('original');
    const transport = await openAgentBrowserTransport('reconnect');
    expect(openAgentBrowserPane).toHaveBeenLastCalledWith({ projectId: 'p', sessionId: 'reconnect' }, undefined, undefined, 'original');
    expect(original.wc.listenerCount('destroyed')).toBe(2); // Lease plus the page-lifetime navigation observer.
    expect(other.wc.listenerCount('destroyed')).toBe(0);
    transport.close();
    // The user may be viewing another tab when this transport is lost; reconnect still belongs to the original tab.
    registry.preferred = 'other';
    vi.mocked(agentSessionContext).mockResolvedValueOnce({ projectId: 'p' } as never);
    vi.mocked(openAgentBrowserPane).mockResolvedValueOnce('original');
    const reconnected = await openAgentBrowserTransport('reconnect');
    expect(openAgentBrowserPane).toHaveBeenLastCalledWith({ projectId: 'p', sessionId: 'reconnect' }, undefined, undefined, 'original');
    reconnected.close();
  });

  it('first navigation forwards the URL and refuses a missing restored page without falling back to another tab', async () => {
    vi.mocked(agentSessionContext).mockResolvedValueOnce({ projectId: 'p' } as never);
    vi.mocked(openAgentBrowserPane).mockResolvedValueOnce('original');
    setAgentBrowserInitialUrl('first', 'https://qwen.test/');
    await expect(openAgentBrowserTransport('first')).rejects.toThrow('no live page');
    expect(openAgentBrowserPane).toHaveBeenLastCalledWith({ projectId: 'p', sessionId: 'first' }, 'https://qwen.test/', undefined, undefined);
  });
});

describe('#7191 只把这一个页签交给 Playwright', () => {
  it.each(['', ':'])('#7627 reports the real initial document URL when Chromium frame metadata is %j', async (url) => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = url;
    const { call, transport } = connect('initial-document', 'initial-tab', wc);
    await call('Target.setAutoAttach', {});
    const response = await call('Page.getFrameTree', {}, 'gugu-agent-page');
    expect(response.result.frameTree.frame).toEqual({ id: 'T1', loaderId: 'L1', url: 'about:blank' });
    expect(dbg.commands.map((command) => command.method)).not.toContain('Page.navigate');
    expect(dbg.frameTree.frame.url).toBe(url);
    transport.close();
  });

  it('#7627 leaves committed frame metadata intact without evaluating the document', async () => {
    const { wc, dbg } = fakeGuest();
    const { call, transport } = connect('committed-document', 'committed-tab', wc);
    await call('Target.setAutoAttach', {});
    const response = await call('Page.getFrameTree', {}, 'gugu-agent-page');
    expect(response.result).toEqual({ frameTree: dbg.frameTree });
    expect(dbg.commands.map((command) => command.method)).not.toContain('Runtime.evaluate');
    transport.close();
  });

  it('#7627 reports an initial-document lookup failure instead of inventing a loaded page', async () => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = '';
    dbg.documentException = { text: 'execution context destroyed' };
    const { call, transport } = connect('failed-document', 'failed-tab', wc);
    await call('Target.setAutoAttach', {});
    const response = await call('Page.getFrameTree', {}, 'gugu-agent-page');
    expect(response.error?.message).toContain('initial document');
    expect(response.result).toBeUndefined();
    transport.close();
  });

  it('#7627 keeps Runtime.enable behind the frame response so default context events are not lost', async () => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = '';
    let finishLookup!: () => void;
    const lookup = new Promise<void>((resolve) => { finishLookup = resolve; });
    const send = dbg.sendCommand.bind(dbg);
    vi.spyOn(dbg, 'sendCommand').mockImplementation(async (method, params, child) => {
      if (method === 'Runtime.evaluate' && (params as { expression?: string }).expression === 'document.URL') await lookup;
      const result = await send(method, params, child);
      if (method === 'Runtime.enable') dbg.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } });
      return result;
    });
    const { call, transport, received } = connect('ordered-document', 'ordered-tab', wc);
    await call('Target.setAutoAttach', {});
    const frame = call('Page.getFrameTree', {}, 'gugu-agent-page');
    const runtime = call('Runtime.enable', {}, 'gugu-agent-page');
    await vi.waitFor(() => expect(dbg.commands.some((command) => command.method === 'Page.getFrameTree')).toBe(true));
    expect(dbg.commands.some((command) => command.method === 'Runtime.enable')).toBe(false);
    finishLookup();
    const response = await frame;
    await runtime;
    expect(received.indexOf(response)).toBeLessThan(received.findIndex((message) => message.method === 'Runtime.executionContextCreated'));
    transport.close();
  });

  it('#7627 uses fresh frame metadata if a navigation commits during the initial document lookup', async () => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = '';
    dbg.documentUrl = 'https://new.test/';
    dbg.onDocumentLookup = () => { dbg.frameTree = { frame: { id: 'T1', loaderId: 'L2', url: dbg.documentUrl } }; };
    const { call, transport } = connect('changing-document', 'changing-tab', wc);
    await call('Target.setAutoAttach', {});
    const response = await call('Page.getFrameTree', {}, 'gugu-agent-page');
    expect(response.result.frameTree.frame).toEqual({ id: 'T1', loaderId: 'L2', url: 'https://new.test/' });
    transport.close();
  });

  it.each(['Page.getFrameTree', 'Runtime.evaluate'])('#7627 closing during %s does not query a destroyed debugger', async (pendingMethod) => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = '';
    dbg.documentUrl = 'https://new.test/';
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const send = dbg.sendCommand.bind(dbg);
    const reached = vi.fn();
    vi.spyOn(dbg, 'sendCommand').mockImplementation(async (method, params, child) => {
      const result = await send(method, params, child);
      if (method === pendingMethod) { reached(); await pending; }
      return result;
    });
    const { call, transport, closes } = connect(`closing-${pendingMethod}`, 'closing-tab', wc);
    await call('Target.setAutoAttach', {});
    transport.send({ id: 99, method: 'Page.getFrameTree', params: {}, sessionId: 'gugu-agent-page' });
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    wc.destroyed = true;
    wc.emit('destroyed');
    const count = dbg.commands.length;
    complete();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toEqual(['the browser tab was closed']);
    expect(dbg.commands).toHaveLength(count);
    transport.close();
    expect(dbg.detachCalls).toBe(0);
  });

  it('#7627 does not rewrite a child target\'s frame tree', async () => {
    const { wc, dbg } = fakeGuest();
    dbg.frameTree.frame.url = '';
    const { call, transport } = connect('child-document', 'parent-tab', wc);
    await call('Target.setAutoAttach', {});
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-1' }, '');
    const response = await call('Page.getFrameTree', {}, 'child-1');
    expect(response.result.frameTree.frame.url).toBe('');
    expect(dbg.commands.map((command) => command.method)).not.toContain('Runtime.evaluate');
    transport.close();
  });

  it('浏览器级命令由这里应答;setAutoAttach 报出唯一的一个 page', async () => {
    const { wc, dbg } = fakeGuest();
    const { call, received } = connect('s1', 'b1', wc);
    // 主进程里 process.versions.chrome 是真版本;这里补一个,判的是 Playwright 那样取主版本号能得到数字。
    Object.defineProperty(process.versions, 'chrome', { value: '144.0.7000.1', configurable: true });
    const product = (await call('Browser.getVersion')).result.product as string;
    expect(Number(product.split('/')[1]?.split('.')[0])).toBe(144);
    await call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect(dbg.attached).toBe(true);
    const attached = received.find((m) => m.method === 'Target.attachedToTarget');
    expect(attached.params.targetInfo.type).toBe('page');
    // 浏览器级的 setAutoAttach ❌ 转给网页(那会把宿主窗口也报上来)
    expect(dbg.commands.map((c) => c.method)).not.toContain('Target.setAutoAttach');
  });

  it.each([
    ['Target.attachToTarget'],
    ['Target.getTargets'],
    ['Target.createTarget'],
    ['Target.attachToBrowserTarget'],
    ['Browser.close'],
  ])('页面会话上的 %s 被拒,不转给网页', async (method) => {
    const { wc, dbg } = fakeGuest();
    const { call } = connect('s1', 'b1', wc);
    await call('Target.setAutoAttach', {});
    const before = dbg.commands.length;
    const reply = await call(method, {}, 'gugu-agent-page');
    expect(reply.error?.message).toContain('not available');
    expect(dbg.commands.length).toBe(before);
  });

  it('浏览器级的未知命令也被拒', async () => {
    const { wc } = fakeGuest();
    const { call } = connect('s1', 'b1', wc);
    expect((await call('Target.attachToBrowserTarget')).error?.message).toContain('not available');
  });

  it('页面命令转给网页:页面会话不带 sessionId,子会话原样带', async () => {
    const { wc, dbg } = fakeGuest();
    const { call } = connect('s1', 'b1', wc);
    await call('Target.setAutoAttach', {});
    await call('Runtime.evaluate', { expression: '1' }, 'gugu-agent-page');
    expect(dbg.commands.at(-1)).toMatchObject({ method: 'Runtime.evaluate', sessionId: undefined });
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-1' }, '');
    await call('Runtime.enable', {}, 'child-1');
    expect(dbg.commands.at(-1)).toMatchObject({ method: 'Runtime.enable', sessionId: 'child-1' });
    expect((await call('Runtime.enable', {}, 'stranger')).error?.message).toBe('unknown session');
  });

  it.each([
    ['Input.insertText', { text: '你好' }],
    ['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] }],
    ['Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }],
  ])('#7274 %s 原样交给网页自己(独立的 view 只在自己那棵焦点树里收字):不聚焦、不借焦点、不改写', async (method, params) => {
    const { wc, dbg } = fakeGuest();
    const { call } = connect('s1', 'b1', wc);
    await call('Target.setAutoAttach', {});
    const before = dbg.commands.length;
    expect((await call(method, params, 'gugu-agent-page')).error).toBeUndefined();
    const sent = dbg.commands.slice(before).filter((c) => c.method !== 'Runtime.evaluate');
    expect(sent).toEqual([{ method, params, sessionId: undefined }]);
  });

  it('页签关掉:报 onclose,之后的命令不再碰 debugger,close 也不 detach 已销毁的网页', async () => {
    const { wc, dbg } = fakeGuest();
    const { call, closes, transport } = connect('s1', 'b1', wc);
    await call('Target.setAutoAttach', {});
    wc.destroyed = true;
    wc.emit('destroyed');
    expect(closes).toEqual(['the browser tab was closed']);
    const before = dbg.commands.length;
    transport.send({ id: 99, method: 'Runtime.evaluate', sessionId: 'gugu-agent-page' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dbg.commands.length).toBe(before);
    transport.close();
    expect(dbg.detachCalls).toBe(0);
  });
});

describe('browser actions pause only when the person presses Stop', () => {

  it('queries current activity through RPC, with no separate pause or resume controls', async () => {
    vi.useFakeTimers();
    const { browserController } = await import('./controller');
    const handlers = new Map<string, Parameters<RpcIpcMainLike['handle']>[1]>();
    registerRPCRouter({ browser: browserController }, { handle: (channel, listener) => void handlers.set(channel, listener) });
    const rpc = createRPCClient<{ browser: typeof browserController }>(async (channel, ...args) => {
      const listener = handlers.get(channel)!;
      return listener({ sender: { id: 1 } }, ...args);
    });
    connect('activity-query', 'activity-query', fakeGuest(56).wc);
    expect(await rpc.browser.agentState('activity-query')).toEqual({ state: 'idle' });
    agentBrowserToolStarting('activity-query');
    expect(await rpc.browser.agentState('activity-query')).toEqual({ state: 'driving' });
    agentBrowserToolFinished('activity-query');
    vi.advanceTimersByTime(3_100);
    expect(await rpc.browser.agentState('activity-query')).toEqual({ state: 'idle' });
    expect(browserController).not.toHaveProperty('pauseAgent');
    expect(browserController).not.toHaveProperty('resumeAgent');
  });

  it('agent 自己合成的点击(刚发过 Input.dispatchMouseEvent)认作 agent 的(页签焦点不跟过去)', async () => {
    const { wc } = fakeGuest(12);
    const { call } = connect('s3', 'b3', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('s3');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, 'gugu-agent-page');
    expect(registry.observer?.('b3')).toBe(true);
    expect(emitted.some((e) => e.browserId === 'b3' && e.state === 'paused')).toBe(false);
    agentBrowserToolFinished('s3');
  });

  it('#7274 人自己的按下不认作 agent 的(页签焦点照常跟过去)', () => {
    const { wc } = fakeGuest(18);
    connect('s9', 'b9', wc);
    expect(registry.observer?.('b9')).toBe(false);
  });

  it.each([0, 500, 20_000, 31_000])('clicking the page at %i ms never pauses browser actions', (delay) => {
    vi.useFakeTimers();
    const id = `ordinary-click-${delay}`;
    const { wc } = fakeGuest(1000 + delay);
    const { transport } = connect(id, id, wc);
    agentBrowserToolStarting(id);
    if (delay > 0) {
      agentBrowserToolFinished(id);
      vi.advanceTimersByTime(delay);
    }
    expect(registry.observer?.(id)).toBe(false);
    expect(agentBrowserStateOf(id)).not.toBe('paused');
    expect(agentBrowserToolStarting(id)).toEqual({ ok: true });
    expect(emitted.some(e => e.browserId === id && e.state === 'paused')).toBe(false);
    transport.close();
  });

  it('第一个动作开始时还没有页签:页签一连上就报 driving,动作结束后照常回 idle', () => {
    vi.useFakeTimers();
    expect(agentBrowserToolStarting('s6')).toEqual({ ok: true });
    expect(emitted.some((e) => e.browserId === 'b6')).toBe(false);
    const { wc } = fakeGuest(16);
    connect('s6', 'b6', wc);
    expect(emitted.at(-1)).toEqual({ browserId: 'b6', state: 'driving' });
    agentBrowserToolFinished('s6');
    vi.advanceTimersByTime(3_100);
    expect(emitted.at(-1)).toEqual({ browserId: 'b6', state: 'idle' });
  });

  it('动作结束几秒后报 idle(后台页签改回不出帧)', () => {
    vi.useFakeTimers();
    const { wc } = fakeGuest(14);
    connect('s5', 'b5', wc);
    agentBrowserToolStarting('s5');
    agentBrowserToolFinished('s5');
    expect(emitted.at(-1)).toEqual({ browserId: 'b5', state: 'driving' });
    vi.advanceTimersByTime(3_100);
    expect(emitted.at(-1)).toEqual({ browserId: 'b5', state: 'idle' });
  });
});

describe('#7274 Playwright 要的 focus emulation 只在 agent 操作期间开着(开着网页就当作看得见、照常出帧)', () => {
  const emulation = (dbg: { commands: Array<{ method: string; params: unknown }> }) =>
    dbg.commands.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled').map((c) => (c.params as { enabled: boolean }).enabled);

  it('操作中 Playwright 要开就开;停手几秒后关掉(后台页签不再出帧);再动又开', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { wc, dbg } = fakeGuest(31);
    const { call } = connect('e1', 'be1', wc);
    await call('Target.setAutoAttach');
    agentBrowserToolStarting('e1');
    const answer = await call('Emulation.setFocusEmulationEnabled', { enabled: true }, 'gugu-agent-page');
    expect(answer.result).toEqual({});
    expect(emulation(dbg)).toEqual([true]);
    agentBrowserToolFinished('e1');
    await vi.advanceTimersByTimeAsync(3_100);
    expect(emulation(dbg)).toEqual([true, false]);
    agentBrowserToolStarting('e1');
    await vi.waitFor(() => expect(emulation(dbg)).toEqual([true, false, true]));
  });

  it('网页销毁后不再碰它的 debugger', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { wc, dbg } = fakeGuest(33);
    const { call } = connect('e3', 'be3', wc);
    await call('Target.setAutoAttach');
    agentBrowserToolStarting('e3');
    await call('Emulation.setFocusEmulationEnabled', { enabled: true }, 'gugu-agent-page');
    agentBrowserToolFinished('e3');
    wc.destroyed = true;
    vi.advanceTimersByTime(3_100);
    expect(emulation(dbg)).toEqual([true]);
  });
});

describe('#7191 人看得见 agent 的鼠标:先飞过去,到了再交给网页', () => {
  const moves = () => emitted.filter((e) => e.kind === 'move');
  const mouse = (id: number, params: object) => ({ id, method: 'Input.dispatchMouseEvent', params, sessionId: 'gugu-agent-page' });
  const forwardedInput = (dbg: { commands: Array<{ method: string; params: unknown }> }) => dbg.commands.filter((c) => c.method.startsWith('Input.'));

  it('点击前那一步移动:报给页签(乘上网页缩放),页签回「到了」才转给网页;按下当场转、页签画一下点击', async () => {
    const { wc, dbg } = fakeGuest(21);
    wc.zoom = 1.25;
    const { transport, received, call } = connect('c1', 'bc1', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('c1');
    transport.send(mouse(50, { type: 'mouseMoved', x: 100, y: 40, button: 'none', buttons: 0 }));
    await vi.waitFor(() => expect(moves().at(-1)).toMatchObject({ browserId: 'bc1', x: 125, y: 50, target: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forwardedInput(dbg)).toHaveLength(0);
    agentCursorArrived(moves().at(-1)!.moveId!);
    await vi.waitFor(() => expect(received.some((m) => m.id === 50)).toBe(true));
    expect(forwardedInput(dbg)).toHaveLength(1);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 40, button: 'left', buttons: 1 }, 'gugu-agent-page');
    expect(emitted.at(-1)).toEqual({ browserId: 'bc1', kind: 'click' });
    expect(forwardedInput(dbg)).toHaveLength(2);
    agentBrowserToolFinished('c1');
  });

  it('Playwright 的一次点击是三条连发(移过去 / 按下 / 抬起):按下、抬起排在移动后面,鼠标到了才一起落下', async () => {
    const { wc, dbg } = fakeGuest(26);
    const { transport, received, call } = connect('c6', 'bc6', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('c6');
    transport.send(mouse(60, { type: 'mouseMoved', x: 70, y: 70, button: 'none', buttons: 0 }));
    transport.send(mouse(61, { type: 'mousePressed', x: 70, y: 70, button: 'left', buttons: 1, clickCount: 1 }));
    transport.send(mouse(62, { type: 'mouseReleased', x: 70, y: 70, button: 'left', buttons: 0, clickCount: 1 }));
    await vi.waitFor(() => expect(moves().some((e) => e.browserId === 'bc6')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forwardedInput(dbg)).toHaveLength(0);
    agentCursorArrived(moves().filter((e) => e.browserId === 'bc6').at(-1)!.moveId!);
    await vi.waitFor(() => expect([60, 61, 62].every((id) => received.some((m) => m.id === id))).toBe(true));
    expect(forwardedInput(dbg).map((c) => (c.params as { type: string }).type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    agentBrowserToolFinished('c6');
  });

  it('drops only cancelled A while its cursor moves and lets concurrent B reach the same page', async () => {
    const { wc, dbg } = fakeGuest(73);
    const { transport, received, closes, call } = connect('parallel-cursor', 'parallel-cursor', wc);
    await call('Target.setAutoAttach');
    agentBrowserToolStarting('parallel-cursor');
    const a = new AbortController(), b = new AbortController();
    try {
      withBrowserCall(a.signal, () => transport.send(mouse(771, { type: 'mouseMoved', x: 80, y: 80, buttons: 0 })));
      await vi.waitFor(() => expect(moves().some(event => event.browserId === 'parallel-cursor')).toBe(true));
      const pendingB = withBrowserCall(b.signal, () => call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b' }, 'gugu-agent-page'));
      a.abort();
      await expect(pendingB).resolves.toHaveProperty('result');
      await vi.waitFor(() => expect(received.some(message => message.id === 771 && message.error)).toBe(true));
      agentCursorArrived(moves().find(event => event.browserId === 'parallel-cursor')!.moveId!);
      await new Promise(done => setImmediate(done));
      expect(forwardedInput(dbg)).toEqual([{ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'b' }, sessionId: undefined }]);
      expect(dbg.detachCalls).toBe(0);
      expect(closes).toEqual([]);
    } finally { agentBrowserToolFinished('parallel-cursor'); transport.close(); }
  });

  it('cancelling a connection while its cursor is moving drops queued input; a new turn can act without unlocking the page', async () => {
    const { wc, dbg } = fakeGuest(27);
    const { transport, call } = connect('cancelled-turn', 'cancelled-tab', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('cancelled-turn');
    transport.send(mouse(63, { type: 'mouseMoved', x: 8, y: 8, buttons: 0 }));
    transport.send(mouse(64, { type: 'mousePressed', x: 8, y: 8, button: 'left', buttons: 1 }));
    transport.send(mouse(65, { type: 'mouseReleased', x: 8, y: 8, button: 'left', buttons: 0 }));
    await vi.waitFor(() => expect(moves().some(e => e.browserId === 'cancelled-tab')).toBe(true));
    transport.close();
    agentCursorArrived(moves().filter(e => e.browserId === 'cancelled-tab').at(-1)!.moveId!);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(forwardedInput(dbg)).toEqual([]);
    agentBrowserToolFinished('cancelled-turn');
    expect(agentBrowserStateOf('cancelled-tab')).toBe('idle');
    const next = connect('cancelled-turn', 'cancelled-tab', wc);
    await next.call('Target.setAutoAttach', {});
    expect(agentBrowserToolStarting('cancelled-turn')).toEqual({ ok: true });
    await next.call('Input.insertText', { text: 'next turn' }, 'gugu-agent-page');
    expect(forwardedInput(dbg)).toEqual([{ method: 'Input.insertText', params: { text: 'next turn' }, sessionId: undefined }]);
    next.transport.close();
    agentBrowserToolFinished('cancelled-turn');
  });

  it('页签没回话(渲染层没挂上)也最多等 1.5 秒,❌ 卡住 agent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { wc, dbg } = fakeGuest(22);
    const { transport, received, call } = connect('c2', 'bc2', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('c2');
    transport.send(mouse(51, { type: 'mouseMoved', x: 5, y: 5, buttons: 0 }));
    await vi.advanceTimersByTimeAsync(1_400);
    expect(forwardedInput(dbg)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(received.some((m) => m.id === 51)).toBe(true));
    expect(forwardedInput(dbg)).toHaveLength(1);
    agentBrowserToolFinished('c2');
  });

  it('打字前鼠标落进有焦点的输入框;逐键打字不每键都去找', async () => {
    const { wc, dbg } = fakeGuest(24);
    dbg.focusedBox = [10, 20, 200, 30];
    const { transport, received, call } = connect('c4', 'bc4', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('c4');
    transport.send({ id: 53, method: 'Input.insertText', params: { text: 'a' }, sessionId: 'gugu-agent-page' });
    await vi.waitFor(() => expect(moves().some((e) => e.browserId === 'bc4')).toBe(true));
    expect(moves().filter((e) => e.browserId === 'bc4').at(-1)).toMatchObject({ x: 26, y: 35, target: [10, 20, 200, 30] });
    expect(forwardedInput(dbg)).toHaveLength(0);
    agentCursorArrived(moves().filter((e) => e.browserId === 'bc4').at(-1)!.moveId!);
    await vi.waitFor(() => expect(received.some((m) => m.id === 53)).toBe(true));
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b' }, 'gugu-agent-page');
    expect(dbg.commands.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);
    expect(moves().filter((e) => e.browserId === 'bc4')).toHaveLength(1);
    agentBrowserToolFinished('c4');
  });

  it('拖拽途中按着键的移动不等(一步一停拖拽就断了)', async () => {
    const { wc, dbg } = fakeGuest(25);
    const { call } = connect('c5', 'bc5', wc);
    await call('Target.setAutoAttach', {});
    agentBrowserToolStarting('c5');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 30, button: 'left', buttons: 1 }, 'gugu-agent-page');
    expect(forwardedInput(dbg)).toHaveLength(1);
    expect(moves().some((e) => e.browserId === 'bc5')).toBe(true);
    agentBrowserToolFinished('c5');
  });
});
