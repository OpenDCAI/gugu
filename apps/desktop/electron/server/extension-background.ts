import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, type Session } from 'electron';
import type { BrowserContext, Page } from 'playwright-core';
import { findChrome, chromeArgs } from '../session/main/core/browser/cloud/chrome';
import { setupExtensionProtocol, type ExtensionBundle } from '../session/main/core/extensions/extension-protocol';
import type { BackgroundRuntime } from '../session/main/core/extensions/extension-background';
import { decideExtensionRequest, applyExtensionCorsGrant, extensionCorsRequest } from '../session/main/core/extensions/extension-network-policy';
import { backgroundWire, BACKGROUND_HOST_EVENT } from '../../src/session/shared/extensions/background-wire';
import { APP_FRAME_MARKER, type FrameToHost, type HostToFrame } from '../../src/session/shared/extensions/app-runtime-protocol';
import type { ExtensionHostEvent } from '../../src/session/shared/extensions/bridge-protocol';
import { log } from '../session/main/lib/logger';
import { extensionsService } from '../session/main/core/extensions/extensions-root';

let nextId = 1;
// A quick disable/enable must wait for the previous browser to release this App's persistent partition.
const retiring = new Map<string, Promise<void>>();
const mime: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

/** The same installed HTML, App runtime, bridge and resource policy, in a browser with no window. */
export function serverExtensionBackground(bundle: ExtensionBundle, entry: string): BackgroundRuntime {
  const id = nextId++;
  let destroyed = false;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let detach: (() => void) | null = null;
  const previous = retiring.get(bundle.extensionId);
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => { release = resolve; });
  retiring.set(bundle.extensionId, lifetime);
  const released = () => {
    release();
    if (retiring.get(bundle.extensionId) === lifetime) retiring.delete(bundle.extensionId);
  };
  let starting = true;
  const origin = `https://${bundle.extensionId}.gugu-app.invalid`;
  const currentBundle = () => ({ ...bundle, networkHosts: extensionsService().grantedHosts(bundle.extensionId) });
  const own = (url: string) => new URL(url).origin === origin;
  const post = async (frame: HostToFrame) => {
    if (!page || destroyed) return;
    await page.evaluate(({ name, data }) => window.dispatchEvent(new CustomEvent(name, { detail: data })), { name: BACKGROUND_HOST_EVENT, data: backgroundWire(frame, true) });
  };
  const tell = (frame: HostToFrame) => { void post(frame).catch((error: unknown) => log.error('Server App background event failed', { extensionId: bundle.extensionId, error })); };
  const runtime: BackgroundRuntime = {
    id,
    isDestroyed: () => destroyed,
    send: (event: ExtensionHostEvent) => tell({ m: APP_FRAME_MARKER, t: 'event', event }),
    destroy() {
      destroyed = true;
      detach?.();
      if (context) void context.close().catch((error: unknown) => log.error('Server App background could not close', { extensionId: bundle.extensionId, error })).finally(released);
      else if (!starting) released();
    },
  };
  void (async () => {
    await previous;
    if (destroyed) { released(); return; }
    const binary = findChrome(process.env);
    if (!binary) throw new Error('App background pages need Chrome or Chromium on this server (GUGU_CLOUD_BROWSER_CHROME selects it)');
    // The server already ships this dependency for its browser tools; never download another browser.
    const requireHere = createRequire(__filename);
    const requireMcp = createRequire(requireHere.resolve('@playwright/mcp'));
    const { chromium } = requireMcp('playwright-core') as typeof import('playwright-core');
    const root = path.join(app.getPath('userData'), 'AppBackgrounds', bundle.extensionId);
    context = await chromium.launchPersistentContext(root, {
      executablePath: binary,
      headless: true,
      serviceWorkers: 'block',
      args: chromeArgs({ userDataDir: root, cacheDir: path.join(root, 'cache'), headless: true, root: process.getuid?.() === 0 })
        .filter((arg) => !arg.startsWith('--remote-debugging-') && !arg.startsWith('--user-data-dir=') && arg !== 'about:blank'),
    });
    starting = false;
    if (destroyed) { await context.close(); released(); return; }
    let serve!: (request: Request) => Response | Promise<Response>;
    setupExtensionProtocol({ protocol: {
      isProtocolHandled: () => false,
      handle: (_scheme: string, handler: typeof serve) => { serve = handler; },
    } } as unknown as Pick<Session, 'protocol'>, currentBundle, async (file) => new Response(await readFile(file), {
      headers: { 'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream' },
    }));
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (own(request.url())) {
        const url = new URL(request.url());
        const response = await serve(new Request(`gugu-ext://${bundle.extensionId}${url.pathname}${url.search}`));
        const headers = Object.fromEntries(response.headers);
        headers['content-security-policy'] = headers['content-security-policy']!.replaceAll(`gugu-ext://${bundle.extensionId}`, origin);
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
        return;
      }
      if (request.isNavigationRequest() || !decideExtensionRequest(request.url(), currentBundle().networkHosts).allowed) {
        await route.abort('blockedbyclient');
        return;
      }
      // Same declared-host CORS grant as the desktop session, under this browser's App origin.
      const headers = { ...request.headers(), origin: `gugu-ext://${bundle.extensionId}` };
      const cors = extensionCorsRequest(headers, bundle.extensionId);
      const response = await route.fetch({ maxRedirects: 0 });
      const granted = cors ? applyExtensionCorsGrant(Object.fromEntries(Object.entries(response.headers()).map(([key, value]) => [key, [value]])), cors) : null;
      await route.fulfill({ response, ...(granted ? { headers: Object.fromEntries(Object.entries(granted).map(([key, values]) => [key, values.join(', ').replaceAll(`gugu-ext://${bundle.extensionId}`, origin)])) } : {}) });
    });
    await context.routeWebSocket('**/*', (socket) => {
      if (decideExtensionRequest(socket.url(), currentBundle().networkHosts).allowed) socket.connectToServer();
      else socket.close();
    });
    page = context.pages()[0] ?? await context.newPage();
    const backgroundPage = page;
    context.on('close', () => { destroyed = true; detach?.(); released(); });
    context.on('page', (opened) => { if (opened !== backgroundPage) void opened.close(); });
    page.on('crash', () => { runtime.destroy(); log.error('Server App background process gone', { extensionId: bundle.extensionId }); });
    const { answerCall, stopPageWatches } = await import('../session/main/core/extensions/extension-bridge');
    const { fileSync } = await import('../session/main/core/extensions/file-sync');
    const sync = fileSync.attachPort(id, bundle.extensionId, { post: (data) => tell({ m: APP_FRAME_MARKER, t: 'sync', data }), close: () => {} });
    detach = () => { fileSync.pageGone(id); stopPageWatches(id); };
    await page.exposeBinding('__guguBackgroundPost', async ({ frame }, payload: unknown) => {
      if (destroyed || frame !== backgroundPage.mainFrame() || !own(frame.url())) throw new Error('This is not the App background document');
      const message = backgroundWire(payload, false) as FrameToHost;
      if (message?.m !== APP_FRAME_MARKER) return;
      if (message.t === 'sync') { fileSync.fromPort(sync, message.data); return; }
      if (message.t !== 'call') return;
      const filePage = () => ({ pageId: id, extensionId: bundle.extensionId, handed: null });
      const answer = await answerCall({
        extensionId: bundle.extensionId, kind: 'background', binding: null, pageId: id,
        filePage, resourcePage: filePage,
        hear: (event) => runtime.send(event),
      }, message.method, (message.args ?? {}) as Record<string, unknown>);
      await post({ m: APP_FRAME_MARKER, t: 'result', id: message.id, ...answer });
    });
    await page.goto(`${origin}/${entry}`);
    log.info('Server App background loaded', { extensionId: bundle.extensionId, pageId: id });
  })().catch((error: unknown) => {
    starting = false;
    runtime.destroy();
    log.error('Server App background failed to load', { extensionId: bundle.extensionId, error });
  });
  return runtime;
}
