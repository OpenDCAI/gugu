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
