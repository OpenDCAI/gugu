import { hostAsks, respond } from '../../../../../../../../tests/support/ask-service';
vi.mock('../../asks', () => import('../../../../../../../../tests/support/ask-service'));
vi.mock('../../asks/ask', () => import('../../../../../../../../tests/support/ask-service'));
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

/**
 * #7199 云浏览器整条链路对着一个真 Chrome 跑一遍:Playwright 工具经每会话一页签的 transport 驱动页面、实时画面帧、
 * 人接管时 agent 被拒、交还后继续、停止 / 继续、接管登录后工具结果里没有密码。
 *
 * 要一个 Chrome / Chromium(CI 上没有)⇒ 默认跳过;本机跑:
 *   GUGU_CLOUD_BROWSER_REAL=<chrome 或 chrome-headless-shell 的路径> npx vitest run --project session-main <本文件>
 */
const chrome = process.env.GUGU_CLOUD_BROWSER_REAL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cloud-browser-'));
const statusHook = vi.hoisted(() => ({ cb: null as null | ((change: { sessionId: string; reading: { running: boolean } }) => void) }));

vi.mock('electron', () => ({
  app: { getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(4),
  },
}));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: { on: (_event: string, cb: typeof statusHook.cb) => (statusHook.cb = cb) },
}));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => ({ workspaceRoot: tmp }) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const LOGIN_PAGE = `<!doctype html><html><head><title>登录测试</title></head><body>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'hello ' + document.getElementById('u').value + ' / ' + document.getElementById('p').value.length;">
<input id="u" name="username" placeholder="账号"><input id="p" type="password" name="password" placeholder="密码"><button type="submit">登录</button>
</form><div id="out"></div><textarea id="note"></textarea></body></html>`;

describe.skipIf(!chrome)('cloud browser against a real Chrome', () => {
  let server: http.Server;
  let base = '';
  let browser: import('./cloud-browser').CloudBrowser;
  let live: import('./live-server').CloudBrowserLiveServer;
  let tools: import('../../../../../browser-agent-mcp').SessionBrowserTools;
  const sessionId = 'session-a';

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { CloudBrowser, cloudAgentBrowserBridge, setCloudBrowserForTests } = await import('./cloud-browser');
    browser = new CloudBrowser({ ...process.env, GUGU_SERVER_MODE: '1', GUGU_CLOUD_BROWSER_CHROME: chrome!, DISPLAY: '', GUGU_SERVER_ACCOUNT: 'test' }, tmp);
    setCloudBrowserForTests(browser);
    const { CloudBrowserLiveServer } = await import('./live-server');
    live = new CloudBrowserLiveServer(browser);
    const { SessionBrowserTools } = await import('../../../../../browser-agent-mcp');
    tools = new SessionBrowserTools(sessionId, () => cloudAgentBrowserBridge(), () => undefined);
  }, 60_000);

  afterAll(async () => {
    await tools?.close();
    live?.close();
    browser?.shutdown();
    server?.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const bridge = (await import('./cloud-browser')).cloudAgentBrowserBridge();
    const gate = bridge.toolStarting(sessionId);
    if (!gate.ok) return { refused: gate.message };
    const startedAt = Date.now() - 1_000;
    try {
      const client = await tools.client();
      const { redactOutputFiles, redactToolResult, withoutOwnFilename } = await import('../../../../../browser-agent-mcp');
      // 与 callBrowserTool 一样:不许自己挑文件名、Playwright 落盘的文字也盖掉
      const raw = (await client.callTool({ name, arguments: withoutOwnFilename(name, args) })) as import('@modelcontextprotocol/sdk/types.js').CallToolResult;
      redactOutputFiles(tools.outputDir, startedAt, bridge.redact!);
      const result = redactToolResult(raw, bridge.redact);
      return { text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') };
    } finally {
      bridge.toolFinished(sessionId);
    }
  }

  function viewer() {
    return new Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }>((resolve, reject) => {
      void live.ensure().then(({ port, token }) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, ['gugu-browser-v1', `gugu-browser-ticket.${token}`]);
        const messages: Array<Record<string, unknown>> = [];
        socket.on('message', (data) => {
          const message = JSON.parse(String(data));
          messages.push(message);
          if (message.type === 'frame') socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
        });
        socket.once('open', () => resolve({ socket, messages }));
        socket.once('error', reject);
      });
    });
  }

  async function until<T>(read: () => T | undefined | null | false, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 从 `from` 条之后找第一条满足的(❌ 拿到先前那条旧状态)。 */
  function waitAfter(messages: Array<Record<string, unknown>>, from: number, match: (m: Record<string, unknown>) => boolean) {
    return until(() => messages.slice(from).find(match));
  }

  it('drives a tab, streams frames, refuses removed forms and redacts a login entered during takeover', async () => {
    const opened = await call('browser_navigate', { url: base });
    expect(opened.text).toContain('登录测试');
    expect(browser.status(null).tabs.some((tab) => tab.url.startsWith(base) && tab.byAgent)).toBe(true);
    // 页签标题是网页标题(Chrome 导航时只报主机名,标题要靠我们去拉)
    await until(() => browser.status(null).tabs.find((tab) => tab.title === '登录测试'));

    // 人看:收得到状态和画面帧
    const { socket, messages } = await viewer();
    socket.send(JSON.stringify({ type: 'config', framesEnabled: true, maxFps: 10, maxWidth: 1280, maxHeight: 800, tabId: null }));
    const frame = await until(() => messages.find((m) => m.type === 'frame'));
    expect(Number(frame.width)).toBeGreaterThan(100);
    expect(Number(frame.viewportWidth)).toBeGreaterThan(100);

    // 人接管:agent 被拒;人点进输入框、发文字;交还后 agent 继续
    let mark = messages.length;
    socket.send(JSON.stringify({ type: 'control_acquire' }));
    await waitAfter(messages, mark, (m) => m.type === 'state' && m.control === 'granted');
    expect((await call('browser_snapshot')).refused).toMatch(/took over/);
    mark = messages.length;
    socket.send(JSON.stringify({ type: 'control_release' }));
    await waitAfter(messages, mark, (m) => m.type === 'state' && m.control === 'released');
    const snapshot = await call('browser_snapshot');
    expect(snapshot.text).toContain('账号');

    // 接管后点画面上的输入框、打字(坐标按视口换算)
    mark = messages.length;
    socket.send(JSON.stringify({ type: 'control_acquire' }));
    await waitAfter(messages, mark, (m) => m.type === 'state' && m.control === 'granted');
    const evalNote = await call('browser_snapshot'); // refused while controlled
    expect(evalNote.refused).toBeTruthy();
    socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 30, y: 18, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mouseReleased', x: 30, y: 18, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_text', id: 't1', text: '人打的字' }));
    await until(() => messages.find((m) => m.type === 'input_result' && m.id === 't1' && m.ok === true));
    // 人自己在密码框里敲密码(Tab 到密码框):交还后 agent 的快照里看不到
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_text', id: 't2', text: 'typed-Secret-77' }));
    await until(() => messages.find((m) => m.type === 'input_result' && m.id === 't2' && m.ok === true));
    mark = messages.length;
    socket.send(JSON.stringify({ type: 'control_release' }));
    await waitAfter(messages, mark, (m) => m.type === 'state' && m.control === 'released');
    const handedBack = await call('browser_snapshot');
    expect(handedBack.text).toContain('人打的字');
    expect(handedBack.text).not.toContain('typed-Secret-77');

    // 停止 / 继续
    socket.send(JSON.stringify({ type: 'automation_stop' }));
    await until(() => messages.find((m) => m.type === 'state' && m.automation === 'stopped'));
    expect((await call('browser_snapshot')).refused).toMatch(/stopped/);
    socket.send(JSON.stringify({ type: 'automation_resume' }));
    await until(() => browser.status(null).automation !== 'stopped');

    // A protocol-13 client is refused immediately, then keeps using the same browser connection.
    mark = messages.length;
    socket.send(JSON.stringify({ type: 'vault_submit', requestId: 'legacy-login', username: 'discarded', password: 'never-fill-this', save: true }));
    await waitAfter(messages, mark, m => m.type === 'vault_result' && m.requestId === 'legacy-login' && m.code === 'feature_removed' && m.reason === 'gone');
    expect(fs.existsSync(path.join(tmp, 'cloud-browser', 'saved-logins.enc'))).toBe(false);

    // Login asks still wait for the person; credentials are entered on the page during takeover.
    await call('browser_navigate', { url: base });
    const login = browser.requestLogin(sessionId, { reason: '查订单' });
    const pending = await until(() => [...(hostAsks.get(sessionId)?.values() ?? [])].find(item => item.request.origin?.source === 'browser-assistance'));
    const requestId = pending.request.itemId;
    expect(pending.request.origin?.payload).not.toHaveProperty('password');
    mark = messages.length;
    socket.send(JSON.stringify({ type: 'control_acquire' }));
    await waitAfter(messages, mark, m => m.type === 'state' && m.control === 'granted');
    socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 30, y: 18, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mouseReleased', x: 30, y: 18, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_text', id: 'login-u', text: 'alice' }));
    await until(() => messages.find(m => m.type === 'input_result' && m.id === 'login-u' && m.ok === true));
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }));
    socket.send(JSON.stringify({ type: 'input_text', id: 'login-p', text: 'typed-Login-88' }));
    await until(() => messages.find(m => m.type === 'input_result' && m.id === 'login-p' && m.ok === true));
    await respond({ conversationId: sessionId, itemId: requestId, kind: 'permission', optionId: 'done', by: 'desktop' });
    const told = await login;
    expect(told.ok).toBe(true);
    expect(told.message).toContain('handed the browser back');
    expect(told.message).not.toContain('typed-Login-88');
    const after = await call('browser_snapshot');
    expect(after.text).not.toContain('typed-Login-88');
    expect(after.text).toContain('••••••');
    expect(fs.existsSync(path.join(tmp, 'cloud-browser', 'saved-logins.enc'))).toBe(false);
    // A subsequent login asks again instead of filling credentials from a removed store.
    const again = browser.requestLogin(sessionId, {});
    const next = await until(() => [...(hostAsks.get(sessionId)?.values() ?? [])].find(item => item.request.itemId !== requestId));
    await respond({ conversationId: sessionId, itemId: next.request.itemId, kind: 'permission', optionId: 'cancel', by: 'desktop' });
    expect((await again).ok).toBe(false);

    // 小图
    const shot = await live.snapshot(null, 480);
    expect(shot?.width).toBeLessThanOrEqual(480);

    // 缓存不在资料夹里(资料夹随存档走):那几个目录是软链,Chrome 照常往里写,写进的是 ~/.cache
    const codeCache = path.join(tmp, 'cloud-browser', 'profile', 'Default', 'Code Cache');
    expect(fs.lstatSync(codeCache).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(codeCache).startsWith(fs.realpathSync(path.join(os.homedir(), '.cache', 'gugu-cloud-browser', 'test')))).toBe(true);
    for (const rel of ['Default/Code Cache', 'Default/GPUCache']) expect(fs.readdirSync(path.join(tmp, 'cloud-browser', 'profile', rel)).length).toBeGreaterThan(0);
    socket.close();
  }, 120_000);
});
