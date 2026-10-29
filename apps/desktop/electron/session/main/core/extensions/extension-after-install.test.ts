import { afterEach, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  retire: vi.fn(), stopBackground: vi.fn(), syncBackgrounds: vi.fn(), notify: vi.fn(), warn: vi.fn(),
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  configureExtensionSession: vi.fn(), isExtensionSessionConfigured: () => false, reloadExtensionSurfaces: vi.fn(),
}));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ grantedHosts: () => [] }) }));
vi.mock('@main/core/extensions/extension-background', () => ({
  stopExtensionBackground: effects.stopBackground, syncExtensionBackgrounds: effects.syncBackgrounds,
}));
vi.mock('@main/core/extensions/extension-programs', () => ({ retireExtensionPrograms: effects.retire }));
vi.mock('@main/core/extensions/extension-bridge', () => ({ notifyInstalledAppsChanged: effects.notify }));
vi.mock('@main/lib/logger', () => ({ log: { warn: effects.warn } }));
const { applyInstalledExtension } = await import('./extension-after-install');
afterEach(() => vi.clearAllMocks());

it('reports failed program retirement after installation without an unhandled rejection', async () => {
  const error = new Error('Projection cleanup timed out');
  effects.retire.mockRejectedValueOnce(error);
  effects.notify.mockResolvedValueOnce(undefined);
  applyInstalledExtension({ manifest: { id: 'projection-app' }, rootDir: '/test/app' });
  await vi.waitFor(() => expect(effects.warn).toHaveBeenCalledWith(
    'Extension program retirement failed after install', { extensionId: 'projection-app', error },
  ));
  expect(effects.stopBackground).toHaveBeenCalledExactlyOnceWith('projection-app');
  expect(effects.syncBackgrounds).toHaveBeenCalledOnce();
  expect(effects.notify).toHaveBeenCalledOnce();
});
