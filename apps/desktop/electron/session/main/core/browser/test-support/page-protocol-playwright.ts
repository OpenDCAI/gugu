import { app, BrowserWindow, WebContentsView } from 'electron';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserPageRuntime } from '../browser-page-runtime';
import { createPaneTransport, agentCursorArrived, agentBrowserToolStarting, agentBrowserToolFinished } from '../agent-browser';
import { createBrowserAppProgram } from '../../../../../browser-agent-mcp';

const cases: Record<string, { passed: boolean; error?: string }> = {};
const commands: string[] = [];
const globals = globalThis as typeof globalThis & { pageProbeEvent?: (_channel: unknown, event: { kind?: string; moveId?: number }) => void };
globals.pageProbeEvent = (_channel, event) => {
  if (event.kind === 'move' && event.moveId) queueMicrotask(() => agentCursorArrived(event.moveId!));
};
app.commandLine.appendSwitch('site-per-process');

async function run() {
  assert.ok(process.env.GUGU_HOME && process.env.GUGU_USER_DATA_DIR);
  app.setPath('userData', process.env.GUGU_USER_DATA_DIR!);
  await app.whenReady();
  assert.equal(app.getPath('userData'), process.env.GUGU_USER_DATA_DIR);
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url?.startsWith('/frame')
      ? '<!doctype html><button id="inside" onclick="document.body.dataset.clicked=\'yes\'">Inside frame</button>'
      : `<!doctype html><title>Scoped browser protocol</title>
        <iframe id="same" src="/frame" title="same origin"></iframe>
        <iframe id="cross" src="http://localhost:${port}/frame" title="cross site"></iframe>
        <div id="drag" draggable="true" style="padding:30px;width:120px" ondragstart="event.dataTransfer.setData('text/plain','fixture')">Drag me</div>
        <div id="drop" style="padding:40px;width:160px" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dropped=event.dataTransfer.getData('text/plain')">Drop here</div>`);
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
  const window = new BrowserWindow({ width: 1100, height: 800 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, partition: 'persist:page-protocol-probe' } });
  const runtime = new BrowserPageRuntime(view);
  runtime.moveTo(window); runtime.layout({ x: 0, y: 0, width: 1080, height: 760 }, true);
  await runtime.navigate(`http://127.0.0.1:${port}/`);
  const contents = view.webContents;
  const nativeSend = contents.debugger.sendCommand.bind(contents.debugger);
  contents.debugger.sendCommand = ((...args: Parameters<typeof nativeSend>) => {
    commands.push(args[0]); return nativeSend(...args);
  }) as typeof nativeSend;
  const program = { extensionId: 'native-page-protocol-test', server: 'browser-use', native: 'browser-use' as const,
    digest: 'test', command: 'test', args: [], env: {}, cwd: process.env.PAGE_PROBE_REPO!, dataDir: process.env.GUGU_HOME! };
  const check = async (name: string, body: () => Promise<void>) => {
    try { await body(); cases[name] = { passed: true }; }
    catch (error) { cases[name] = { passed: false, error: String(error) }; }
  };
  for (const frame of ['same', 'cross']) await check(frame + '-iframe-click', async () => {
    const provider = createBrowserAppProgram(() => ({
      openTransport: async (sid, signal) => createPaneTransport(sid, sid, contents, signal), toolStarting: agentBrowserToolStarting,
      toolFinished: agentBrowserToolFinished, setInitialUrl() {}, workspaceRoot: async () => program.cwd,
    }));
    const sid = 'iframe-' + frame;
    try {
      const result = await provider.call(program, { name: 'browser_click', arguments: {
        target: `#${frame} >> internal:control=enter-frame >> #inside`,
      }, _meta: { 'gugu/sessionId': sid } }, new AbortController().signal);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(commands.includes('DOM.getFrameOwner'));
      // Read the native child frame itself, including the cross-site OOPIF.
      const nativeFrame = contents.mainFrame.frames.find(child => child.url.includes(frame === 'same' ? '127.0.0.1' : 'localhost'));
      assert.ok(nativeFrame);
      assert.equal(await nativeFrame.executeJavaScript('document.body.dataset.clicked'), 'yes');
    } finally { await provider.retire(program.extensionId); }
  });
  await check('html-drag', async () => {
    const provider = createBrowserAppProgram(() => ({
      openTransport: async (sid, signal) => createPaneTransport(sid, sid, contents, signal), toolStarting: agentBrowserToolStarting,
      toolFinished: agentBrowserToolFinished, setInitialUrl() {}, workspaceRoot: async () => program.cwd,
    }));
    try {
      const result = await provider.call(program, { name: 'browser_drag', arguments: { startTarget: '#drag', endTarget: '#drop' },
        _meta: { 'gugu/sessionId': 'drag' } }, new AbortController().signal);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(await contents.executeJavaScript('document.body.dataset.dropped'), 'fixture');
      assert.ok(commands.includes('Input.setInterceptDrags') && commands.includes('Input.dispatchDragEvent'));
    } finally { await provider.retire(program.extensionId); }
  });
  const requireHere = createRequire(path.join(process.env.PAGE_PROBE_REPO!, 'package.json'));
  const { chromium } = createRequire(requireHere.resolve('@playwright/mcp'))('playwright-core') as typeof import('playwright-core');
  for (const cause of ['surface failed', 'the page debugger is already in use']) await check(cause, async () => {
    const failureView = new WebContentsView({ webPreferences: { sandbox: true } });
    const failurePage = new BrowserPageRuntime(failureView);
    failurePage.moveTo(window);
    const visible = failureView.setVisible.bind(failureView);
    if (cause === 'surface failed') failureView.setVisible = () => { throw new Error(cause); };
    else failureView.webContents.debugger.attach('1.3');
    const transport = createPaneTransport('early-' + cause, 'failure', failureView.webContents);
    await new Promise<void>(resolve => setImmediate(resolve));
    failureView.setVisible = visible;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        chromium.connectOverCDP(transport).then(() => '', error => String(error)),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('lost close: still waiting'), 2000); }),
      ]);
      assert.ok(error.includes(cause), error);
      assert.equal(failureView.webContents.debugger.isAttached(), cause !== 'surface failed');
    } finally { clearTimeout(timer); transport.close(); failurePage.close(); }
  });
  process.stdout.write('PAGE_PROTOCOL_RESULT=' + JSON.stringify({ cases, commands }) + '\n');
  runtime.close(); window.destroy(); server.closeAllConnections(); server.close();
}
void run().then(() => app.exit(0), error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
