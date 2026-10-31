import { verifiedFileHandle } from '../../../../../../../tests/support/verifiedFileHandle';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { extensionsInventoryChangedChannel, extensionsQuitChangedChannel } from '@shared/extensions/marketEvents';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// behavior tab-extensions (#2374) —— controller 这一层的**接线**。
//
// 服务层知道哪些 host 还被授权,会话层会按给它的清单拦截 —— 但「控制器有没有把前者
// 交给后者」中间这一步此前没有判据。撤销权限只要漏在这里,服务层测试照样全绿、
// 会话层测试也照样全绿,而真机上开关拨了却什么都没发生。
//
// 所以这里只用真 ExtensionsService(临时目录)+ 假 session,判的是**交出去的那份清单**。

const userDataDir = mkdtempSync(join(tmpdir(), 'gugu-ext-controller-'));

// 一个开着的 tab(#6656 卸载时 tab 还开着):真桥绑定它,它在工作副本上的监听走假 runtime。
const surface = {
  id: 7,
  session: {},
  hostWebContents: null,
  isDestroyed: () => false,
  once: () => undefined,
  on: () => undefined,
  send: () => undefined,
};

const bridgeHandlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => bridgeHandlers.set(channel, fn), on: () => undefined },
  webContents: { fromId: (id: number) => (id === surface.id ? surface : undefined) },
}));
// The session a page names (`{ session }`): main finds its working copy the one way it finds a session's (真源原则 13).
const sessionRoot = mkdtempSync(join(tmpdir(), 'gugu-ext-controller-ws-'));
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (id: string) => ({ sessionId: id, projectId: 'p', workspaceRoot: sessionRoot }),
}));

let fileChange: ((update: { kind: 'resync' }) => void) | null = null;
let unwatched = 0;
/** 绑定 surface 时监听是异步建起来的;建起来的那一刻由这里告诉用例。 */
let watchStarted: (() => void) | undefined;
vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: async () => ({
      value: {
        files: {
          watchChanges: (_root: string, cb: (update: { kind: 'resync' }) => void) => {
            fileChange = cb;
            watchStarted?.();
            return { success: true, data: { unsubscribe: () => (unwatched += 1), ready: Promise.resolve() } };
          },
        },
      },
      release: () => undefined,
    }),
  },
}));

const emitted: { name: string; data: unknown }[] = [];
vi.mock('@main/lib/events', () => ({
  events: {
    emit: (event: { name: string }, data: unknown) => emitted.push({ name: event.name, data }),
    on: () => () => undefined,
  },
  // The local file service hears the working copies' change stream through it (file-sync.ts).
  tapMainEvents: () => () => undefined,
}));

const configured: { extensionId: string; networkHosts: readonly string[] }[] = [];

const hardened = new Set<string>();
const reloaded: string[] = [];

vi.mock('@main/core/extensions/extension-session', () => ({
  configureExtensionSession: (bundle: { extensionId: string; networkHosts: readonly string[] }) => {
    hardened.add(bundle.extensionId);
    configured.push({ extensionId: bundle.extensionId, networkHosts: [...bundle.networkHosts] });
    return {};
  },
  isExtensionSessionConfigured: (extensionId: string) => hardened.has(extensionId),
  extensionIdForSession: () => [...hardened][0] ?? null,
  reloadExtensionSurfaces: (extensionId: string) => {
    reloaded.push(extensionId);
  },
  clearExtensionSessionData: vi.fn(async (extensionId: string) => {
    hardened.delete(extensionId);
  }),
}));

vi.mock('@main/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

// The chat card's Install: the download is stubbed and the consent relay records what it was asked, so a test reads
// whether the card's click alone installs a package.
const attachmentFixture = vi.hoisted(() => ({ bytes: new Uint8Array() }));
const consentRequests = vi.hoisted(() => [] as { manifest: { id: string } }[]);
vi.mock('@gugu/core/cloud/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSupabaseUrl: () => 'https://db.test',
}));
// Who published a card's package (app-identity.ts): read from the identity directory, which a unit test has none of.
vi.mock('./app-files', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readAccount: async () => ({ type: 'human', owner_user_id: null, display_name: 'profile name' }),
  // #7290 A card's message, as main reads it as the person: in the group folder, published by one person; its bytes signed.
  packageReads: {
    message: async (id: string) => ({
      id, content: '[附件] x.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file',
      file_item_id: '44444444-4444-4444-8444-444444444444', file_version: 1, file_blob_id: null,
      sender_user_id: '0a000000-0000-4000-8000-00000000000a',
    }),
    open: async () => verifiedFileHandle(attachmentFixture.bytes, {}, async signal => new Uint8Array(await (await fetch('https://cdn.test/ab/abab?auth_key=1', { signal })).arrayBuffer())),
  },
}));
// 「给哪些 agent」要读账号的行;这些用例没有登录态，不问(D-30 自己的读写在 app-given 的用例里判)。
// 读不到时安装会失败(owner 10-17 体检 #21),所以这里把「问」定成没有可问的，而不是靠吞错。
vi.mock('./app-given', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-given')>()),
  installGrant: async () => null,
  recordInstallGrant: async () => undefined,
  forgetAccountGrants: vi.fn(async () => undefined),
}));
vi.mock('./extension-bridge-relay', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestExtensionInstallConsent: async (request: { manifest: { id: string } }) => {
    consentRequests.push(request);
    return { outcome: 'declined' };
  },
  notifyInstalledExtensionsChanged: async () => undefined,
}));

// An icon as main re-encodes it: its path and size stand in for the PNG (no nativeImage here).
vi.mock('./extension-icon', () => ({
  renderExtensionIcon: (_rootDir: string, path: string, pixels?: number) => ({ dataUrl: `png:${path}@${pixels ?? 32}` }),
}));

import { extensionsController } from './controller';
import { extensionSurfaceBindingForTests, onInstalledAppsChanged, registerExtensionBridge } from './extension-bridge';
import { EXTENSION_BRIDGE_CHANNEL } from '@shared/extensions/bridge-protocol';
import { packExtensionArchive } from './extension-archive';
import { extensionsService } from './extensions-root';
import { forgetAccountGrants } from './app-given';
import { clearExtensionSessionData } from './extension-session';
import { cloudExtensionMarket } from './market-catalog-root';
import { extensionPrograms, onExtensionProgramNotification, stopAllExtensionPrograms, type ExtensionProgram } from './extension-programs';
import { installedComputerUseApps } from '../../../../computer-use-program';
import { syncDeviceHeartbeat } from '@gugu/core/cloud/deviceRuntime';
import { MemoryHeartbeatClient } from '../../../../../../../tests/support/deviceRuntimeHarness';

const EXTENSION_ID = 'demo-ext';

function writeBundle(hosts: string[], tab: Record<string, unknown> = { name: 'demo', title: 'Demo' }, capabilities?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-ext-controller-src-'));
  const bundle = join(dir, 'bundle');
  mkdirSync(bundle);
  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      id: EXTENSION_ID,
      name: 'Demo',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'],
      entry: 'index.html',
      permissions: { network: hosts, ...(capabilities ? { capabilities } : {}) },
      contributes: { tabs: [tab] },
    })
  );
  writeFileSync(join(bundle, 'index.html'), '<!doctype html>');
  return bundle;
}

/** What a folder's install would ask (`consent: return`): the sheet, and whether it asks anything. */
async function folderAsk(sourceDir: string): Promise<{ outcome: 'ask'; ask: { manifestDigest: string }; asks: boolean }> {
  const handed = await extensionsController.installFromFolder({ sourceDir, consent: { kind: 'return' } });
  expect(handed.success, handed.error).toBe(true);
  return handed.data as never;
}
/** The folder installed with the yes given to the sheet it was read from — the digest the person was shown. */
function folderGiven(sourceDir: string, digest: string) {
  return extensionsController.installFromFolder({ sourceDir, consent: { kind: 'given', digest } });
}

async function installViaController(hosts: string[], tab?: Record<string, unknown>, capabilities?: string[]): Promise<void> {
  const source = writeBundle(hosts, tab, capabilities);
  const inspected = await folderAsk(source);
  const installed = await folderGiven(source, inspected.ask.manifestDigest);
  expect(installed.success, installed.error).toBe(true);
}

beforeEach(async () => {
  configured.length = 0;
  reloaded.length = 0;
  const { extensions } = extensionsService().list();
  for (const entry of extensions) await extensionsController.uninstall({ extensionId: entry.manifest.id });
});

describe('extensions controller', () => {
  it('an uninstall still clears state and publishes inventory when native retirement rejects', async () => {
    await installViaController([]);
    const identity = { publisher: 'gugu', id: EXTENSION_ID };
    const identityOf = vi.spyOn(extensionsService(), 'identityOf').mockReturnValue(identity);
    vi.mocked(clearExtensionSessionData).mockClear();
    vi.mocked(forgetAccountGrants).mockClear();
    emitted.length = 0;
    extensionPrograms.registerNative('computer-use', {
      tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }),
      retire: async () => { throw new Error('native cleanup failed'); },
    });
    try {
      expect(await extensionsController.uninstall({ extensionId: EXTENSION_ID, lastAnywhere: true })).toEqual({ success: true });
      expect(clearExtensionSessionData).toHaveBeenCalledWith(EXTENSION_ID);
      expect(forgetAccountGrants).toHaveBeenCalledWith(identity);
      expect(emitted).toContainEqual({ name: extensionsInventoryChangedChannel.name, data: { extensionId: EXTENSION_ID } });
    } finally {
      identityOf.mockRestore();
      extensionPrograms.registerNative('computer-use', {
        tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }), retire: async () => {},
      });
    }
  });

  it('uninstall waits for native cleanup before deleting App storage', async () => {
    await installViaController([]);
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    extensionPrograms.registerNative('computer-use', {
      tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }),
      retire: async () => { entered.resolve(); await cleanup.promise; },
    });
    vi.mocked(clearExtensionSessionData).mockClear();
    let outcome = 'pending';
    const uninstalled = extensionsController.uninstall({ extensionId: EXTENSION_ID }).then(result => { outcome = 'answered'; return result; });
    try {
      await entered.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(outcome).toBe('pending');
      expect(clearExtensionSessionData).not.toHaveBeenCalled();
      cleanup.resolve();
      expect(await uninstalled).toEqual({ success: true });
      expect(clearExtensionSessionData).toHaveBeenCalledWith(EXTENSION_ID);
    } finally {
      cleanup.resolve();
      await uninstalled;
      extensionPrograms.registerNative('computer-use', {
        tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }), retire: async () => {},
      });
    }
  });

  it('a quick reinstall retains its grants and storage when old native cleanup finishes', async () => {
    await installViaController([]);
    const identityOf = vi.spyOn(extensionsService(), 'identityOf').mockReturnValue({ publisher: 'gugu', id: EXTENSION_ID });
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let retiring = false;
    extensionPrograms.registerNative('computer-use', {
      tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }),
      retire: async () => { if (retiring) return; retiring = true; entered.resolve(); await cleanup.promise; },
    });
    vi.mocked(clearExtensionSessionData).mockClear();
    vi.mocked(forgetAccountGrants).mockClear();
    const uninstalled = extensionsController.uninstall({ extensionId: EXTENSION_ID, lastAnywhere: true });
    try {
      await entered.promise;
      await installViaController([]);
      vi.mocked(clearExtensionSessionData).mockClear();
      cleanup.resolve();
      expect(await uninstalled).toEqual({ success: true });
      expect(extensionsService().isInstalled(EXTENSION_ID)).toBe(true);
      expect(forgetAccountGrants).not.toHaveBeenCalled();
      expect(clearExtensionSessionData).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await uninstalled;
      identityOf.mockRestore();
      extensionPrograms.registerNative('computer-use', {
        tools: async () => [], call: async () => ({ content: [] }), status: () => ({ running: 0 }), retire: async () => {},
      });
    }
  });

  it.each(['disable', 'permission', 'uninstall'] as const)('%s interrupts an already running App program', async (action) => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-app-revoke-'));
    const release = join(root, 'release');
    const script = join(root, 'server.mjs');
    writeFileSync(script, String.raw`
import { existsSync } from 'node:fs';
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id === undefined) continue;
    const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    if (message.method === 'initialize') reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'revoke', version: '1' } });
    if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/revoke/started' }) + '\n');
      const finish = () => existsSync(process.argv[2]) ? reply({ content: [{ type: 'text', text: 'completed' }] }) : setTimeout(finish, 10);
      finish();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
    const source = writeBundle([], undefined, ['agents:tools']);
    const manifestPath = join(source, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.contributes.mcpServers = [{ name: 'revocation-test', command: 'node', args: ['server.mjs'] }];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(source, 'server.mjs'), readFileSync(script));
    const inspected = await folderAsk(source);
    expect((await folderGiven(source, inspected.ask.manifestDigest)).success).toBe(true);
    const target: ExtensionProgram = { extensionId: EXTENSION_ID, server: 'revocation-test', digest: action,
      command: process.execPath, args: [script, release], cwd: root, env: {}, dataDir: join(root, 'data') };
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const off = onExtensionProgramNotification((id, server, notification) => {
      if (id === EXTENSION_ID && server === target.server && notification.method === 'notifications/revoke/started') started();
    });
    let outcome = 'pending';
    const call = extensionPrograms.call(target, { name: 'hold' }, { signal: new AbortController().signal })
      .then(() => { outcome = 'completed'; }, () => { outcome = 'interrupted'; });
    try {
      await entered;
      const result = action === 'disable' ? await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: false })
        : action === 'permission' ? await extensionsController.setPermissionGranted({ extensionId: EXTENSION_ID, permission: 'agents:tools', granted: false })
          : await extensionsController.uninstall({ extensionId: EXTENSION_ID });
      expect(result.success).toBe(true);
      await expect.poll(() => outcome, { timeout: 1_000 }).toBe('interrupted');
      await expect(extensionPrograms.call(target, { name: 'hold' }, { signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'denied' });
    } finally {
      off();
      writeFileSync(release, '');
      await call;
      await stopAllExtensionPrograms();
    }
  });

  it('lists variant metadata with the inventory and isolates an unreadable App', async () => {
    await installViaController([]);
    const other = writeBundle([]);
    const file = join(other, 'manifest.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), id: 'other-app' }));
    extensionsService().installFromDirectory(other, extensionsService().inspectDirectory(other).manifestDigest, 'folder');
    const service = extensionsService();
    const readVariants = service.variants.bind(service);
    const failing = vi.spyOn(service, 'variants').mockImplementation((id) => {
      if (id === EXTENSION_ID) throw new Error('variant metadata unreadable');
      return readVariants(id);
    });
    try {
      const listed = await extensionsController.list();
      expect(listed.success, listed.error).toBe(true);
      expect(listed.data?.extensions.map(({ id }) => id).sort()).toEqual([EXTENSION_ID, 'other-app'].sort());
      expect(listed.data?.variants).toEqual({ 'other-app': { active: 'upstream', variants: [] } });
    } finally {
      failing.mockRestore();
    }
    expect((await extensionsController.list()).data?.variants?.[EXTENSION_ID]).toEqual({ active: 'upstream', variants: [] });
  });

  it('publishes current Computer Use capability after App changes without rescanning between heartbeats', async () => {
    const service = extensionsService();
    const installed = vi.fn(() => service.list().extensions.flatMap(({ manifest }) =>
      (manifest.contributes.mcpServers ?? []).flatMap((server) => 'host' in server ? [{
        extensionId: manifest.id, server: server.name, native: server.host,
      } as ExtensionProgram] : [])));
    let off: (() => void) | undefined;
    const apps = installedComputerUseApps({ installed, agentToolsRefusal: extensionPrograms.agentToolsRefusal }, (listener) => {
      off = onInstalledAppsChanged(listener);
    });
    const clock = vi.spyOn(Date, 'now');
    const client = new MemoryHeartbeatClient();
    let beatNumber = 0;
    const heartbeat = () => {
      clock.mockReturnValue(++beatNumber * 30_000);
      return syncDeviceHeartbeat(client, {
        userId: 'owner', deviceId: 'device', capabilities: { terminals: [], runtimes: [] },
        deviceActions: () => ({ v: 1, actions: [], ...(apps().length ? {} : { switched_off: [{ group: 'computer', detail: 'Computer Use is off' }] }) }),
      }, {});
    };
    const beat = async (on: boolean) => {
      await heartbeat();
      expect((client.upserts.at(-1)?.row.capabilities as { actions: { switched_off?: unknown } }).actions.switched_off === undefined).toBe(on);
      const reads = installed.mock.calls.length;
      apps(); // The preview reads the same list as the heartbeat.
      await heartbeat();
      expect(installed).toHaveBeenCalledTimes(reads);
    };
    const install = async (host: 'computer-use' | 'browser-use') => {
      const source = writeBundle([], undefined, ['agents:tools']);
      const file = join(source, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.contributes.mcpServers = [{ name: 'control', host }];
      writeFileSync(file, JSON.stringify(manifest));
      const inspected = await folderAsk(source);
      const result = await folderGiven(source, inspected.ask.manifestDigest);
      expect(result.success, result.error).toBe(true);
    };
    try {
      await beat(false);
      await install('computer-use');
      await beat(true);
      await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: false });
      await beat(false);
      await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: true });
      await beat(true);
      await install('browser-use'); // Replacing the same id can remove its native capability.
      await beat(false);
      await install('computer-use');
      await beat(true);
      for (const granted of [false, true]) {
        await extensionsController.setPermissionGranted({ extensionId: EXTENSION_ID, permission: 'agents:tools', granted });
        await beat(granted);
      }
      const reads = installed.mock.calls.length;
      await extensionsController.setSettings({ extensionId: EXTENSION_ID, settings: {} });
      await beat(true);
      expect(installed.mock.calls.length).toBeGreaterThan(reads);
      await extensionsController.uninstall({ extensionId: EXTENSION_ID });
      await beat(false);
    } finally {
      off?.();
      clock.mockRestore();
    }
  });

  it('refuses a folder with no platform declaration or only a phone interface before asking for consent', async () => {
    for (const platforms of [undefined, ['phone']]) {
      const source = writeBundle([]);
      const file = join(source, 'manifest.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), platforms }));
      const result = await extensionsController.installFromFolder({ sourceDir: source, consent: { kind: 'return' } });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(platforms ? /does not support desktop/ : /declare desktop, phone, or both/);
      expect(extensionsService().list().extensions).toEqual([]);
    }
  });

  it('refuses to activate an extension that is switched off, and lists it as off', async () => {
    await installViaController([]);
    const off = await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: false });
    expect(off.success, off.error).toBe(true);
    expect(off.data?.disabled).toEqual([EXTENSION_ID]);
    // Open surfaces are torn down at once, not on the next activate.
    expect(reloaded).toContain(EXTENSION_ID);

    const result = await extensionsController.activate({ extensionId: EXTENSION_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/switched off/);

    const listed = await extensionsController.list();
    expect(listed.data?.disabled).toEqual([EXTENSION_ID]);

    const on = await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: true });
    expect(on.data?.disabled).toEqual([]);
    expect((await extensionsController.activate({ extensionId: EXTENSION_ID })).success).toBe(true);
  });

  // #7050 左栏「退出」:启用不变,主进程记着它退出了;它的页再被要(任何一处 activate)就作废,并告诉每个窗口。
  it('quits an App until it is opened again, and says so each time it changes', async () => {
    await installViaController([]);
    const quitEvents = () => emitted.filter((event) => event.name === extensionsQuitChangedChannel.name).map((event) => event.data);
    emitted.length = 0;

    const quit = await extensionsController.quit({ extensionId: EXTENSION_ID });
    expect(quit.success, quit.error).toBe(true);
    expect(quit.data?.quit).toEqual([EXTENSION_ID]);
    expect(quitEvents()).toEqual([{ quit: [EXTENSION_ID] }]);
    const listed = await extensionsController.list();
    expect(listed.data?.quit).toEqual([EXTENSION_ID]);
    expect(listed.data?.disabled).toEqual([]);

    expect((await extensionsController.activate({ extensionId: EXTENSION_ID })).success).toBe(true);
    expect(quitEvents()).toEqual([{ quit: [EXTENSION_ID] }, { quit: [] }]);
    expect((await extensionsController.list()).data?.quit).toEqual([]);
    // Opened again while not quit: nothing changed, nothing said.
    await extensionsController.activate({ extensionId: EXTENSION_ID });
    expect(quitEvents()).toHaveLength(2);

    // Switched off, it is not running anyway: the quit goes with it, and on again it runs as anything on does.
    await extensionsController.quit({ extensionId: EXTENSION_ID });
    await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: false });
    expect((await extensionsController.list()).data?.quit).toEqual([]);
    await extensionsController.setEnabled({ extensionId: EXTENSION_ID, enabled: true });

    // An App that is not installed cannot be quit.
    expect((await extensionsController.quit({ extensionId: 'nope' })).success).toBe(false);
  });

  // L11 64: a window takes an uninstalled App's tabs back from the inventory event alone (no second, local withdrawal),
  // so the event must be out before the answer the Settings card awaits.
  it('an uninstall tells every window before it answers', async () => {
    await installViaController([]);
    emitted.length = 0;
    const toldBeforeAnswer = await extensionsController
      .uninstall({ extensionId: EXTENSION_ID })
      .then(() => emitted.filter((event) => event.name === extensionsInventoryChangedChannel.name).map((event) => event.data));
    expect(toldBeforeAnswer).toEqual([{ extensionId: EXTENSION_ID }]);
  });

  // The far-left rail's dock (统筹 10-01): this machine's pinned Apps, in order — one write of the whole list.
  it('keeps the dock in the order given, refuses what cannot open from the rail, and forgets an uninstalled App', async () => {
    await installViaController([]);
    // A first install of an App with a page of its own goes on the rail (owner 10-06「装之后应该自动 pin 吧」).
    expect((await extensionsController.list()).data?.dock).toEqual([EXTENSION_ID]);
    expect((await extensionsController.setDock({ ids: [] })).data?.dock).toEqual([]);
    const pinned = await extensionsController.setDock({ ids: [EXTENSION_ID, EXTENSION_ID] });
    expect(pinned.success, pinned.error).toBe(true);
    expect(pinned.data?.dock).toEqual([EXTENSION_ID]);
    expect((await extensionsController.list()).data?.dock).toEqual([EXTENSION_ID]);

    // Not installed here: refused, and the dock stays as it was.
    expect((await extensionsController.setDock({ ids: [EXTENSION_ID, 'ghost-app'] })).success).toBe(false);
    expect((await extensionsController.list()).data?.dock).toEqual([EXTENSION_ID]);

    // A reinstall arrives off the rail; one that only opens files has no page of its own to pin.
    await extensionsController.uninstall({ extensionId: EXTENSION_ID });
    await installViaController([], { name: 'demo', title: 'Demo', opensFiles: { session: ['.demo'] } });
    expect((await extensionsController.list()).data?.dock).toEqual([]);
    const refused = await extensionsController.setDock({ ids: [EXTENSION_ID] });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/only opens files/);
  });

  it('hands the session what is granted, not what the manifest declared', async () => {
    await installViaController(['a.example.com', 'b.example.com']);
    extensionsService().setPermissionGranted(EXTENSION_ID, 'a.example.com', false);

    const result = await extensionsController.activate({ extensionId: EXTENSION_ID });

    expect(result.success, result.error).toBe(true);
    // The declared list still has both; only what was granted may be enforced.
    expect(configured.at(-1)?.networkHosts).toEqual(['b.example.com']);
  });

  it('reconfigures the live session the moment a host is taken back', async () => {
    await installViaController(['a.example.com']);
    await extensionsController.activate({ extensionId: EXTENSION_ID });
    expect(configured.at(-1)?.networkHosts).toEqual(['a.example.com']);

    const result = await extensionsController.setPermissionGranted({
      extensionId: EXTENSION_ID,
      permission: 'a.example.com',
      granted: false,
    });

    expect(result.success, result.error).toBe(true);
    // Not "next time it activates": the surface the user is looking at must stop
    // reaching that host now, which only happens if the session is reconfigured here.
    expect(configured.at(-1)?.networkHosts).toEqual([]);
    expect(result.data?.revoked).toEqual(['a.example.com']);
    // The filter binds at once, but the CSP was stamped when the document
    // loaded — an open surface would keep a header naming a host that is now
    // blocked, which is the disagreement this design exists to avoid.
    expect(reloaded, 'the open surface must be reloaded so its CSP agrees').toContain(
      EXTENSION_ID
    );
  });

  it('gives a host back the same way', async () => {
    await installViaController(['a.example.com']);
    extensionsService().setPermissionGranted(EXTENSION_ID, 'a.example.com', false);

    await extensionsController.setPermissionGranted({
      extensionId: EXTENSION_ID,
      permission: 'a.example.com',
      granted: true,
    });

    expect(configured.at(-1)?.networkHosts).toEqual(['a.example.com']);
  });

  it('rebinds an already-open surface when an upgrade narrows what it asks for', async () => {
    await installViaController(['a.example.com', 'b.example.com']);
    await extensionsController.activate({ extensionId: EXTENSION_ID });
    expect(configured.at(-1)?.networkHosts).toEqual(['a.example.com', 'b.example.com']);

    // The new bundle's files are served from the same directory immediately, so
    // waiting for the next activate would leave the tab the user is looking at
    // enforcing the previous version's list — the wrong direction for a version
    // that asks for *less*.
    await installViaController(['a.example.com']);

    expect(configured.at(-1)?.networkHosts).toEqual(['a.example.com']);
  });

  it('does not harden a session for an extension nobody has opened', async () => {
    await installViaController(['a.example.com']);
    // Installing is not activating: the attach gate admits configured
    // partitions, and configuring one for a surface that was never opened would
    // widen what may attach for no reason.
    expect(configured).toEqual([]);
  });

  it('reports what each installed extension has had taken back', async () => {
    await installViaController(['a.example.com', 'b.example.com']);
    extensionsService().setPermissionGranted(EXTENSION_ID, 'b.example.com', false);

    const result = await extensionsController.revoked();

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ [EXTENSION_ID]: ['b.example.com'] });
  });

  it('asks nothing again for the same folder asking nothing new: the settings card installs it at the click', async () => {
    expect((await folderAsk(writeBundle(['a.example.com']))).asks).toBe(true);
    await installViaController(['a.example.com']);
    expect((await folderAsk(writeBundle(['a.example.com']))).asks).toBe(false);
  });

  it('never gives back a withdrawal on an install: kept while declared, gone once the version stops declaring it', async () => {
    await installViaController(['a.example.com', 'b.example.com']);
    extensionsService().setPermissionGranted(EXTENSION_ID, 'a.example.com', false);
    extensionsService().setPermissionGranted(EXTENSION_ID, 'b.example.com', false);

    // Asked or not, an install is no way to switch one back on: only the person does, in settings.
    await installViaController(['a.example.com', 'c.example.com']);
    expect(extensionsService().revokedPermissions(EXTENSION_ID)).toEqual(['a.example.com']);
    expect(extensionsService().grantedHosts(EXTENSION_ID)).toEqual(['c.example.com']);

    // Declaring it again after a version that did not is new, and asked about: nothing is left withdrawn.
    await installViaController(['c.example.com']);
    await installViaController(['a.example.com', 'c.example.com']);
    expect(extensionsService().revokedPermissions(EXTENSION_ID)).toEqual([]);
  });

  // 复核 10-15: a market App installs one way (installFromMarket); the generic install is a folder's, whatever the caller says —
  // else any folder could be put in as the market's (gugu's), and replaced by another market copy without asking.
  it('installs a folder as a folder: an origin passed in is not taken', async () => {
    const source = writeBundle(['a.example.com']);
    const inspected = await folderAsk(source);
    const installed = await extensionsController.installFromFolder({ sourceDir: source, consent: { kind: 'given', digest: inspected.ask.manifestDigest }, origin: 'market' } as never);
    expect(installed.success, installed.error).toBe(true);
    expect(extensionsService().origins()[EXTENSION_ID]).toBe('folder');
  });

  it('refuses to install a folder that changed after its permissions were shown', async () => {
    const source = writeBundle(['a.example.com']);
    const inspected = await folderAsk(source);
    writeFileSync(
      join(source, 'manifest.json'),
      JSON.stringify({
        id: EXTENSION_ID,
        name: 'Demo',
        version: '1.0.0',
        apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'],
        entry: 'index.html',
        permissions: { network: ['evil.example.com'] },
        contributes: { tabs: [{ name: 'demo', title: 'Demo' }] },
      })
    );

    const installed = await folderGiven(source, inspected.ask.manifestDigest);

    expect(installed.success).toBe(false);
    expect(installed.error).toMatch(/not the one the person agreed to/);
    expect(extensionsService().list().extensions).toEqual([]);
  });

  it('packs an installed extension to forward, and exports the same bytes where a test names the file (#6646)', async () => {
    await installViaController([]);
    const packed = await extensionsController.packInstalled({ extensionId: EXTENSION_ID });
    expect(packed.success, packed.error).toBe(true);
    const { bytes, sha256, fileName, mimeType, saved } = packed.data!;
    expect([fileName, mimeType, saved]).toEqual(['demo-ext-1.0.0.guguext', 'application/vnd.gugu.extension+zip', null]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);

    const target = join(mkdtempSync(join(tmpdir(), 'gugu-export-hook-')), 'out.guguext');
    vi.stubEnv('GUGU_SESSION_TEST_HOOKS', '1');
    vi.stubEnv('GUGU_EXTENSION_EXPORT_PATH', target);
    const exported = await extensionsController.packInstalled({ extensionId: EXTENSION_ID, save: true });
    vi.unstubAllEnvs();
    expect([exported.data?.saved, exported.data?.sha256]).toEqual([target, sha256]);
    expect(createHash('sha256').update(readFileSync(target)).digest('hex')).toBe(sha256);
  });

  it('installs from the chat card without a second prompt when the package asks for nothing; the click is the consent', async () => {
    const sendInChat = async (id: string, network: string[]) => {
      const dir = join(mkdtempSync(join(tmpdir(), 'gugu-ext-card-')), id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
        permissions: { network }, contributes: { tabs: [{ name: 'main', title: id }] },
      }));
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      const { bytes } = await packExtensionArchive(extensionsService(), dir);
      attachmentFixture.bytes = new Uint8Array(bytes);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes))));
    };
    // The card by its message: its publisher the server's word on it (摩擦单 F66, #7290).
    const install = () => extensionsController.installAttachment({ messageId: 'm-card' });
    consentRequests.length = 0;
    try {
      await sendInChat('card-quiet', []);
      await expect(install()).resolves.toMatchObject({ success: true, data: { installed: true, id: 'card-quiet' } });
      expect(consentRequests).toEqual([]);
      // Asking for something still waits for the person.
      await sendInChat('card-asks', ['example.com']);
      await expect(install()).resolves.toMatchObject({ success: true, data: { installed: false, outcome: 'declined' } });
      expect(consentRequests.map((request) => request.manifest.id)).toEqual(['card-asks']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * 一个扩展可以贡献 1–8 个 tab —— 但在补上 per-tab entry 之前,每一个 tab 拿到的都是
 * `manifest.entry`,而 `getContext()` 又不说自己是哪一个贡献。也就是说「多个 tab」是
 * 一句声明得出、兑现不了的话:两个 tab 画同一页,分不开。
 */
describe('每个 tab 画自己那一页', () => {
  async function installTwoTabBundle(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-ext-two-tab-'));
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle);
    writeFileSync(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        id: EXTENSION_ID,
        name: 'Demo',
        version: '1.0.0',
        apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'],
        entry: 'left.html',
        contributes: {
          tabs: [
            { name: 'left', title: 'Left', entry: 'left.html' },
            { name: 'right', title: 'Right', entry: 'right.html' },
          ],
        },
      })
    );
    writeFileSync(join(bundle, 'left.html'), '<!doctype html>');
    writeFileSync(join(bundle, 'right.html'), '<!doctype html>');
    const inspected = await folderAsk(bundle);
    const installed = await folderGiven(bundle, inspected.ask.manifestDigest);
    expect(installed.success, installed.error).toBe(true);
  }

  it('两个 tab 拿到两个不同的地址', async () => {
    await installTwoTabBundle();

    const left = await extensionsController.activate({
      extensionId: EXTENSION_ID,
      tabKind: `${EXTENSION_ID}.left`,
    });
    const right = await extensionsController.activate({
      extensionId: EXTENSION_ID,
      tabKind: `${EXTENSION_ID}.right`,
    });

    expect(left.data?.entryUrl).toMatch(/left\.html$/);
    expect(right.data?.entryUrl).toMatch(/right\.html$/);
    // 对照:两个地址相同的话,上面两条断言在旧行为下也能各自成立(左边恰好就是
    // manifest.entry),所以真正判假的是这一条。
    expect(right.data?.entryUrl).not.toBe(left.data?.entryUrl);
  });

  it('不说是哪个 tab 时,还是 manifest 自己的那一页', async () => {
    await installTwoTabBundle();

    const result = await extensionsController.activate({ extensionId: EXTENSION_ID });

    expect(result.data?.entryUrl).toMatch(/left\.html$/);
  });

  it('认不出的 tab 报错停,❌ 不回落到别人的页', async () => {
    // 回落看上去更「稳」,实则是把一个拼错的 kind 变成一次静默的张冠李戴 —— 用户看到
    // 的是另一个 tab 的内容,而没有任何地方说出过错。
    await installTwoTabBundle();

    const result = await extensionsController.activate({
      extensionId: EXTENSION_ID,
      tabKind: `${EXTENSION_ID}.middle`,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not a tab of extension/);
  });
});

// owner 10-17: 日历、雷达 declare their App's icon and none on their tab — the 「+」 menu, the workspace panel and the tab
// drew the generic mark beside them. A tab without an icon of its own is drawn with its App's; its own still wins.
// (Control: the parent commit, where `icons` had no entry for the first tab.)
describe('a tab\'s icon: its own, else its App\'s (owner 10-17)', () => {
  it('a tab naming no icon gets the App\'s, at the tab\'s size; a tab naming one keeps its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-ext-controller-tabicon-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      id: EXTENSION_ID, name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html', icon: 'app.png',
      contributes: { tabs: [{ name: 'plain', title: 'Plain' }, { name: 'own', title: 'Own', icon: 'tab.png' }] },
    }));
    for (const file of ['index.html', 'app.png', 'tab.png']) writeFileSync(join(dir, file), file);
    const inspected = await folderAsk(dir);
    expect((await folderGiven(dir, inspected.ask.manifestDigest)).success).toBe(true);
    const listed = (await extensionsController.list()).data!;
    expect(listed.icons).toEqual({ [`${EXTENSION_ID}.plain`]: 'png:app.png@32', [`${EXTENSION_ID}.own`]: 'png:tab.png@32' });
    expect(listed.appIcons[EXTENSION_ID]).toMatch(/^png:app\.png@/);
  });
});

describe('agent tools up front or on demand (W-08)', () => {
  const TOOLS_ID = 'tools-ext';

  async function installToolsBundle(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-ext-controller-tools-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      id: TOOLS_ID, name: 'Tools', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html',
      permissions: { capabilities: ['agents:tools'] },
      contributes: { tabs: [{ name: 'main', title: 'Tools' }], mcpServers: [{ name: 'rows', command: 'node', args: ['server.mjs'] }] },
    }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'server.mjs'), '');
    const inspected = await folderAsk(dir);
    const installed = await folderGiven(dir, inspected.ask.manifestDigest);
    expect(installed.success, installed.error).toBe(true);
  }

  it('lists only tool-giving extensions, progressive by default', async () => {
    await installViaController([]);
    await installToolsBundle();

    const listed = await extensionsController.list();
    expect(listed.data?.disclosure).toEqual({ [TOOLS_ID]: 'progressive' });
  });

  it('switches to full and back, and refuses an extension that is not installed', async () => {
    await installToolsBundle();

    const full = await extensionsController.setDisclosure({ extensionId: TOOLS_ID, level: 'full' });
    expect(full.success, full.error).toBe(true);
    expect(full.data?.level).toBe('full');
    expect((await extensionsController.list()).data?.disclosure[TOOLS_ID]).toBe('full');

    const back = await extensionsController.setDisclosure({ extensionId: TOOLS_ID, level: 'progressive' });
    expect(back.data?.level).toBe('progressive');
    expect((await extensionsController.list()).data?.disclosure[TOOLS_ID]).toBe('progressive');

    const missing = await extensionsController.setDisclosure({ extensionId: 'not-installed', level: 'full' });
    expect(missing.success).toBe(false);
  });
});

describe('who works a page the window draws (owner 10-14)', () => {
  it('is the person, whatever the renderer sends: only main binds a page for an agent', async () => {
    await installViaController([], undefined, ['files:read']);
    await extensionsController.activate({ extensionId: EXTENSION_ID });
    const forged = { operator: { kind: 'agent', id: 'user:forged' } } as object;
    const bound = await extensionsController.bindSurface({ webContentsId: surface.id, extensionId: EXTENSION_ID, sessionId: 'task-1', tabId: 'tab-1', tabKind: `${EXTENSION_ID}.demo`, ...forged });
    expect(bound.success, bound.error).toBe(true);
    // What getContext().operator answers is the binding's (extension-bridge-relay.test reads it through the bridge).
    expect(extensionSurfaceBindingForTests(surface.id)?.operator).toEqual({ kind: 'person' });
  });
});

describe('卸载时 tab 还开着(#6656)', () => {
  it('main 当场解绑、停掉它的监听,并告诉窗口撤下 tab(退回占位)', async () => {
    await installViaController([], undefined, ['files:read']);
    await extensionsController.activate({ extensionId: EXTENSION_ID });
    const watching = Promise.withResolvers<void>();
    watchStarted = watching.resolve;
    const bound = await extensionsController.bindSurface({
      webContentsId: surface.id,
      extensionId: EXTENSION_ID,
      sessionId: 'task-1',
      tabId: 'tab-1',
      tabKind: `${EXTENSION_ID}.demo`,
    });
    expect(bound.success, bound.error).toBe(true);
    // The page asks to hear its session's working copy (`files.onChanged({ session }, fn)`): that watch is what uninstall stops.
    registerExtensionBridge();
    const asked = (await bridgeHandlers.get(EXTENSION_BRIDGE_CHANNEL)!(
      { sender: { id: surface.id, session: surface.session } },
      { method: 'filesWatch', args: { watchId: 'working-copy', place: { session: 'task-1' }, on: true } },
    )) as { ok: boolean };
    expect(asked).toMatchObject({ ok: true });
    await watching.promise;
    watchStarted = undefined;
    unwatched = 0;
    emitted.length = 0;

    const result = await extensionsController.uninstall({ extensionId: EXTENSION_ID });

    expect(result.success, result.error).toBe(true);
    // 修复前:绑定和监听都还在,下一次文件变化去问 service,抛 `App not installed`,主进程退出。
    expect(extensionSurfaceBindingForTests(surface.id)).toBeUndefined();
    expect(unwatched).toBe(1);
    expect(() => fileChange?.({ kind: 'resync' })).not.toThrow();
    expect(emitted).toContainEqual({
      name: 'extensions.inventory.changed',
      data: { extensionId: EXTENSION_ID },
    });
  });
});

// #6950: the detail dialog asked only the market for a README, so an App installed from a folder always read
// "the author did not write a README" with README.md sitting in its folder.
describe('what the market has to say about the Apps here (marketUpdates)', () => {
  it('asks about each App installed here but a preinstalled one — gugu updates those itself, and the market could not replace one', async () => {
    const source = writeBundle([]);
    extensionsService().installFromDirectory(source, extensionsService().inspectDirectory(source).manifestDigest, 'preinstalled');
    const updatesFor = vi.spyOn(cloudExtensionMarket(), 'updatesFor').mockResolvedValue({ checkedAt: '2026-10-16T00:00:00.000Z', updates: {}, yanked: {}, deprecated: {} });
    try {
      expect((await extensionsController.marketUpdates()).success).toBe(true);
      expect(updatesFor).toHaveBeenLastCalledWith([]);
      // Control: once it is the person's (a build that no longer ships it released it), the market is asked about it.
      extensionsService().releasePreinstalled(EXTENSION_ID);
      await extensionsController.marketUpdates();
      expect(updatesFor).toHaveBeenLastCalledWith([{ id: EXTENSION_ID, version: '1.0.0', fromMarket: true }]);
    } finally {
      updatesFor.mockRestore();
      // The next case's cleanup uninstalls what is here, and a preinstalled App cannot be uninstalled.
      if (extensionsService().origins()[EXTENSION_ID] === 'preinstalled') extensionsService().releasePreinstalled(EXTENSION_ID);
    }
  });
});

// 精选卡的首帧占位图:页面经 marketRead 读下载站上那张图的字节(形状同手机壳的 GuguAppStore.marketRead)。只读 `media/`,有硬上限。
describe('marketRead: one file under the market media, for the featured card placeholder', () => {
  it('answers base64, never asks for more than the cap, and refuses anything outside media/', async () => {
    const media = vi.spyOn(cloudExtensionMarket(), 'media');
    media.mockResolvedValueOnce(new Uint8Array([1, 2]));
    expect(await extensionsController.marketRead({ path: 'media/pomo/shot.png', maxBytes: 10 ** 9 })).toEqual({ success: true, data: { base64: 'AQI=' } });
    expect(media).toHaveBeenLastCalledWith('media/pomo/shot.png', 2 * 1024 * 1024);
    media.mockRestore();
    for (const path of ['index.json', 'bundles/pomo/1.0.0.zip', 'media/../index.json', '/media/pomo/shot.png', 'https://elsewhere.example/media/a.png']) {
      expect((await extensionsController.marketRead({ path })).success, path).toBe(false);
    }
  });
});

describe('the README a detail dialog shows', () => {
  it('is the installed copy’s own README.md for the installed version, and the market’s for any other', async () => {
    const source = writeBundle([]);
    writeFileSync(join(source, 'README.md'), '# Demo\n\nREADME-6950-MARKER\n');
    const inspected = await folderAsk(source);
    const installed = await folderGiven(source, inspected.ask.manifestDigest);
    expect(installed.success, installed.error).toBe(true);
    const market = vi.spyOn(cloudExtensionMarket(), 'readme').mockResolvedValue('# From the market');

    expect(await extensionsController.marketReadme({ extensionId: EXTENSION_ID, version: '1.0.0' })).toEqual({
      success: true,
      data: { readme: '# Demo\n\nREADME-6950-MARKER\n' },
    });
    expect(market).not.toHaveBeenCalled();

    expect(await extensionsController.marketReadme({ extensionId: EXTENSION_ID, version: '2.0.0' })).toEqual({
      success: true,
      data: { readme: '# From the market' },
    });
    expect(await extensionsController.marketReadme({ extensionId: 'not-installed', version: '1.0.0' })).toEqual({
      success: true,
      data: { readme: '# From the market' },
    });
    market.mockRestore();
  });

  // #7059 从市场装的:读市场那份 —— 那份里的截图改写成了下载站地址,包里的相对路径在产品页画不出来;连不上才读装好的那份。
  it('is the market’s for the installed version of an App installed from the market, the installed copy’s when it cannot be reached', async () => {
    const source = writeBundle([]);
    writeFileSync(join(source, 'README.md'), '# Demo\n\n![shot](shots/a.png)\n');
    const inspected = await folderAsk(source);
    // Installed as the market's, as installExtensionFromMarket records it (the controller's `install` takes folders only).
    extensionsService().installFromDirectory(source, inspected.ask.manifestDigest, 'market');
    const market = vi.spyOn(cloudExtensionMarket(), 'readme').mockResolvedValue('# Demo\n\n![shot](https://download.example/market/media/a.png)\n');
    expect(await extensionsController.marketReadme({ extensionId: EXTENSION_ID, version: '1.0.0' })).toEqual({
      success: true,
      data: { readme: '# Demo\n\n![shot](https://download.example/market/media/a.png)\n' },
    });
    market.mockRejectedValue(new Error('offline'));
    expect(await extensionsController.marketReadme({ extensionId: EXTENSION_ID, version: '1.0.0' })).toEqual({
      success: true,
      data: { readme: '# Demo\n\n![shot](shots/a.png)\n' },
    });
    market.mockRestore();
  });

  it('is none for the installed version when its package has no README, without asking the market', async () => {
    await installViaController([]);
    const market = vi.spyOn(cloudExtensionMarket(), 'readme').mockResolvedValue('# From the market');
    expect(await extensionsController.marketReadme({ extensionId: EXTENSION_ID, version: '1.0.0' })).toEqual({
      success: true,
      data: { readme: null },
    });
    expect(market).not.toHaveBeenCalled();
    market.mockRestore();
  });
});
