// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../../../../electron/lib/logger';
import { createNode, createReactHarness, clickElement } from '../../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../../tests/support/awaitCondition';
import { ExtensionsService } from '@main/core/extensions/extensions-service';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';

const log = createLogger('test/notification-settings-card');
const h = vi.hoisted(() => ({ service: null as unknown as ExtensionsService, setPermission: vi.fn() }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({
  value: { enabled: true, sound: true }, update: vi.fn(), isLoading: false, isFieldOverridden: () => false, resetField: vi.fn(),
}) }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: { extensions: {
  list: async () => ({ success: true, data: { extensions: h.service.list().extensions.map((entry) => entry.manifest), invalid: [] } }),
  revoked: async () => ({ success: true, data: Object.fromEntries(h.service.list().extensions.map(({ manifest }) => [manifest.id, h.service.revokedPermissions(manifest.id)])) }),
  setPermissionGranted: (args: { extensionId: string; permission: string; granted: boolean }) => {
    h.setPermission(args);
    h.service.setPermissionGranted(args.extensionId, args.permission, args.granted);
    return Promise.resolve({ success: true, data: { revoked: h.service.revokedPermissions(args.extensionId) } });
  },
} } }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: { fromId: () => undefined } }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => h.service }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-notifications', () => ({ showExtensionNotification: async () => ({ shown: true }) }));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/core/extensions/extension-programs', () => ({ onExtensionProgramNotification: () => () => {} }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {} }));
vi.mock('@main/core/extensions/extension-file-events', () => ({ watchWorkspaceForSurface: vi.fn() }));
vi.mock('@main/core/extensions/extension-projection-bridge', () => ({ extensionProjections: { isCleanup: () => false } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import NotificationSettingsCard from './NotificationSettingsCard';
import { answerCall, type BridgeCaller } from '@main/core/extensions/extension-bridge';

let ui: ReturnType<typeof createReactHarness>;
let root: string;
beforeEach(() => { ui = createReactHarness(); });
afterEach(() => {
  ui.cleanup();
  if (root) { expect(root.startsWith(join(tmpdir(), 'gugu-notification-card-'))).toBe(true); log.info({ root }, 'cleanup owned fixture'); rmSync(root, { recursive: true }); }
});

describe('App notification permission in the task settings', () => {
  it('renders settings with an installed App that declares no permissions and does not list that App', async () => {
    root = mkdtempSync(join(tmpdir(), 'gugu-notification-card-'));
    const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'index.html'), '<p>Plain</p>');
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ id: 'plain', name: 'Plain', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'],
      entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Plain' }] } }));
    h.service = new ExtensionsService(join(root, 'installed'));
    h.service.installFromDirectory(source, h.service.inspectDirectory(source).manifestDigest, 'folder');
    await installedExtensionsStore.load();
    expect(installedExtensionsStore.manifests[0]?.permissions).toBeUndefined();
    await ui.render(createNode(NotificationSettingsCard));
    expect(ui.container.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(ui.container.textContent).not.toContain('Plain');
  });

  it('uses the product-page grant so the actual bridge refuses the next notify, and restoration allows it', async () => {
    root = mkdtempSync(join(tmpdir(), 'gugu-notification-card-'));
    const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'index.html'), '<p>Notes</p>');
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'],
      entry: 'index.html', permissions: { capabilities: ['notifications'] }, contributes: { tabs: [{ name: 'main', title: 'Notes' }] } }));
    h.service = new ExtensionsService(join(root, 'installed'));
    h.service.installFromDirectory(source, h.service.inspectDirectory(source).manifestDigest, 'folder');
    const caller = { extensionId: 'notes', kind: 'background', binding: null, pageId: 7 } as BridgeCaller;
    const notify = () => answerCall(caller, 'notify', { title: 'Please review' });
    expect(await notify()).toEqual({ ok: true, value: { shown: true } });
    await ui.render(createNode(NotificationSettingsCard));
    await until('permission inventory', () => Boolean(ui.container.querySelector('[role="switch"][aria-label="Notes"]:not(:disabled)')));
    const toggle = () => ui.container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Notes"]')!;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await clickElement(toggle());
    expect(h.setPermission).toHaveBeenLastCalledWith({ extensionId: 'notes', permission: 'notifications', granted: false });
    expect(h.service.grantedCapabilities('notes')).not.toContain('notifications');
    expect(await notify()).toMatchObject({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "notifications"' });
    await clickElement(toggle());
    expect(h.service.grantedCapabilities('notes')).toContain('notifications');
    expect(await notify()).toEqual({ ok: true, value: { shown: true } });
  });
});
