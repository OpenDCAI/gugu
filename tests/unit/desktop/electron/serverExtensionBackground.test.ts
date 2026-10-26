import { beforeEach, expect, it, vi } from 'vitest';

const { launch, closeFirst, releaseFirst, gone } = vi.hoisted(() => {
  let release!: () => void;
  const closing = new Promise<void>((resolve) => { release = resolve; });
  return { launch: vi.fn(), closeFirst: vi.fn(() => closing), releaseFirst: () => release(), gone: vi.fn() };
});
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/server-background-test' } }));
vi.mock('node:module', () => ({ createRequire: () => Object.assign(() => ({ chromium: { launchPersistentContext: launch } }), { resolve: () => '/runtime/mcp' }) }));
vi.mock('../../../../apps/desktop/electron/session/main/core/browser/cloud/chrome', () => ({ findChrome: () => '/chrome', chromeArgs: () => [] }));
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/extension-protocol', () => ({ setupExtensionProtocol: () => {} }));
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ grantedHosts: () => [] }) }));
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/extension-bridge', () => ({ answerCall: vi.fn(), stopPageWatches: vi.fn() }));
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/file-sync', () => ({ fileSync: { attachPort: vi.fn(), pageGone: gone } }));
vi.mock('../../../../apps/desktop/electron/session/main/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { serverExtensionBackground } from '../../../../apps/desktop/electron/server/extension-background';

beforeEach(() => { launch.mockReset(); });

it('waits for a retired background to release its partition before reopening the same App', async () => {
  const page = { on: vi.fn(), exposeBinding: vi.fn(), goto: vi.fn(), mainFrame: vi.fn(), evaluate: vi.fn() };
  const makeContext = (close: () => Promise<void>) => ({ close, route: vi.fn(), routeWebSocket: vi.fn(), pages: () => [page], on: vi.fn() });
  launch.mockResolvedValueOnce(makeContext(closeFirst)).mockResolvedValueOnce(makeContext(async () => {}));
  const bundle = { extensionId: 'timer', rootDir: '/apps/timer', networkHosts: [] };
  const first = serverExtensionBackground(bundle, 'background.html');
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());
  first.destroy();
  const second = serverExtensionBackground(bundle, 'background.html');
  await Promise.resolve();
  expect(launch).toHaveBeenCalledOnce();
  releaseFirst();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
  second.destroy();
  expect(first.isDestroyed()).toBe(true);
  expect(second.isDestroyed()).toBe(true);
});
