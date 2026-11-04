import { describe, expect, it, vi } from 'vitest';

/**
 * An App's language and theme are the host's own records (its locale store, its window tone), read when asked.
 * Before, the relay held a made-up 'en' / 'dark' until the session page's renderer reported — an App's background
 * page starts first on a restart, so a Chinese user's first reminder went out in English (mac1, 2026-10-09), and on a
 * server, where no renderer ever reports, it stayed 'en' for good.
 */

const pushContextToAllSurfaces = vi.fn();
vi.mock('@main/core/extensions/extension-bridge', () => ({
  pushContextToAllSurfaces,
  pushAppStateToAllSurfaces: vi.fn(),
  setExtensionBridgeHost: vi.fn(),
}));

const { openProjectionViewer } = await import('./projection-viewer-provider');
const { extensionBridgeRelayHost, setExtensionHostWindowChannel } = await import('./extension-bridge-relay');

function channel(record: { locale: string; tone: 'light' | 'dark' }) {
  let presentationChanged = () => {};
  const value = {
    invokeRendererExtensions: vi.fn(),
    requestExtensionInstallConsent: vi.fn(),
    closeExtensionInstallConsent: vi.fn(),
    notifyInstalledExtensionsChanged: vi.fn(),
    drawMemberFaces: vi.fn(),
    listedSession: vi.fn(),
    act: vi.fn(),
    isHostWindowFullScreen: () => false,
    onHostWindowFullScreenChange: () => () => {},
    isHostWindowFocused: () => true,
    onHostWindowFocusChange: () => () => {},
    hostLocale: () => record.locale,
    hostTone: () => record.tone,
    onHostPresentationChange: (listener: () => void) => {
      presentationChanged = listener;
      return () => {};
    },
  };
  return { value, change: () => presentationChanged() };
}

describe('the presentation an App is given is the host record, from the first ask', () => {
  it('answers the recorded language and tone with nothing reported by a renderer', () => {
    setExtensionHostWindowChannel(channel({ locale: 'zh-CN', tone: 'light' }).value);
    expect(extensionBridgeRelayHost.presentation()).toMatchObject({ locale: 'zh-CN', themeMode: 'light' });
  });

  it('reads the record each time and tells open surfaces when it moves', () => {
    const record = { locale: 'zh-CN', tone: 'light' as 'light' | 'dark' };
    const host = channel(record);
    setExtensionHostWindowChannel(host.value);
    pushContextToAllSurfaces.mockClear();

    record.locale = 'en-US';
    record.tone = 'dark';
    host.change();

    expect(pushContextToAllSurfaces).toHaveBeenCalledTimes(1);
    expect(extensionBridgeRelayHost.presentation()).toMatchObject({ locale: 'en-US', themeMode: 'dark' });
  });

  it('with no host channel it fails loudly instead of answering a default', () => {
    setExtensionHostWindowChannel(null);
    expect(() => extensionBridgeRelayHost.presentation()).toThrow(/never injected/);
  });
});

it('injects media through the real host channel and withdraws it when that channel ends', async () => {
  const client = { signal: new AbortController().signal, open: vi.fn(), answer: vi.fn(), sign: vi.fn(), close: vi.fn() };
  const open = vi.fn(async () => client);
  setExtensionHostWindowChannel({ ...channel({ locale: 'zh-CN', tone: 'light' }).value, openProjectionViewer: open });
  await expect(openProjectionViewer(42)).resolves.toBe(client);
  expect(open).toHaveBeenCalledWith(42);
  setExtensionHostWindowChannel(null);
  expect(() => openProjectionViewer(42)).toThrow('no authenticated');
});
