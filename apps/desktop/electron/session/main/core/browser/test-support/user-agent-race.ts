import { app, BrowserWindow, WebContentsView, session } from 'electron';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createPaneTransport } from '../agent-browser';
import { stripEmbeddedBrowserTokens } from '../browser-user-agent';

async function run(): Promise<void> {
  if (process.env.UA_PROBE_BOOTSTRAP === '1') {
    await import('../../../../../browser-user-agent-bootstrap');
  }
  app.setPath('userData', process.env.GUGU_USER_DATA_DIR!);
  await app.whenReady();
  process.stderr.write('UA_PROBE_STAGE=app-ready\n');

  const requests: Array<{ url: string; userAgent: string | undefined }> = [];
  const pending = Promise.withResolvers<void>();
  const server = http.createServer((request, response) => {
    if (request.url === '/pending') {
      pending.resolve();
      return; // Keep the first native navigation uncommitted until CDP takes over.
    }
    requests.push({ url: request.url!, userAgent: request.headers['user-agent'] });
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/landing'
      ? '<!doctype html><title>UA test</title><iframe src="/form"></iframe>'
      : '<!doctype html><title>Form</title><input aria-label="Account">');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const profile = session.fromPartition('persist:ua-race');
  const clean = stripEmbeddedBrowserTokens(profile.getUserAgent(), app.getName());
  profile.setUserAgent(clean);

  const window = new BrowserWindow({ width: 800, height: 600, show: false });
  const view = new WebContentsView({ webPreferences: { session: profile, sandbox: true } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const contents = view.webContents;
  // Even an explicit per-page override (the first candidate fix) is bypassed
  // while the initial NavigationEntry does not yet inherit that override.
  contents.setUserAgent(clean);
  // The old policy sees no change: both getters report clean while Chromium's
  // initial document and subsequent CDP navigations use the application fallback.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && contents.getUserAgent() !== clean) contents.setUserAgent(clean);
  });
  void contents.loadURL(`${base}/pending`).catch(() => undefined);
  await pending.promise;
  process.stderr.write('UA_PROBE_STAGE=native-request-pending\n');

  const requireHere = createRequire(path.join(process.env.UA_PROBE_REPO!, 'package.json'));
  const requireFromMcp = createRequire(requireHere.resolve('@playwright/mcp'));
  const { chromium } = requireFromMcp('playwright-core') as typeof import('playwright-core');
  const transport = createPaneTransport('ua-race', 'ua-race', contents);
  const browser = await chromium.connectOverCDP(transport);
  process.stderr.write('UA_PROBE_STAGE=cdp-connected\n');
  try {
    const page = browser.contexts()[0]!.pages()[0]!;
    const initialDocumentAgent = await page.evaluate(() => navigator.userAgent);
    await page.goto(`${base}/landing`);
    process.stderr.write('UA_PROBE_STAGE=cdp-navigation-complete\n');
    const documentAgents = await Promise.all(page.frames().map((frame) => frame.evaluate(() => navigator.userAgent)));
    process.stdout.write(`UA_PROBE_RESULT=${JSON.stringify({
      clean,
      profileAgent: profile.getUserAgent(),
      contentsAgent: contents.getUserAgent(),
      fallback: app.userAgentFallback,
      initialDocumentAgent,
      documentAgents,
      requests: requests.filter((request) => request.url === '/landing' || request.url === '/form'),
    })}\n`);
  } finally {
    transport.close();
    window.destroy();
    server.closeAllConnections();
    server.close();
  }
}

void run().then(() => app.exit(0), (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  app.exit(1);
});
