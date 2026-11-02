// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settlement } from '@gugu/session-core/session-record/contract';
import { useHostAskBand } from './use-session-host-ask';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), respond: vi.fn(), toast: vi.fn(), sheet: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sessionTimeline: { sessionRespond: mocks.respond } },
  rpcOn: () => ({ sessionTimeline: {
    sessionSnapshot: mocks.snapshot, sessionSubscribe: mocks.subscribe, sessionUnsubscribe: mocks.unsubscribe,
  } }),
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => undefined } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./install-consent', () => ({ askInShell: mocks.sheet, installConsentPrompt: () => ({ title: 'Install Reader?' }) }));
vi.mock('@shared/extensions/manifest', async (original) => ({
  ...await original<typeof import('@shared/extensions/manifest')>(),
  safeParseExtensionManifest: (manifest: unknown) => ({ ok: true, manifest }),
}));

const ask: Settlement = {
  itemId: 'ask-1', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
  options: [{ optionId: 'install', name: 'Install' }, { optionId: 'decline', name: 'Decline' }],
  origin: { source: 'app-install', payload: { request: {
    requestId: 'ask-1', sourceDir: '/tmp/reader', manifest: { id: 'reader', name: 'Reader' },
    manifestDigest: 'reader-digest', revokedPermissions: [], given: { first: true },
  } } },
};
let root: Root;
let container: HTMLDivElement;
let band: ReturnType<typeof useHostAskBand>;
function Probe() {
  band = useHostAskBand('session-1', { status: 'needs_user', detail: 'approval' });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.snapshot.mockResolvedValue({ ok: true, value: { settlements: [ask], cursor: {} } });
  mocks.subscribe.mockResolvedValue(undefined);
  mocks.unsubscribe.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(band).not.toBeNull();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('session approval band response feedback', () => {
  it.each([
    ['session_not_found', 'This session is no longer on the host'],
    ['host_ask_refused', 'The host refused this install answer'],
  ])('shows the host message when the answer returns %s', async (code, message) => {
    mocks.respond.mockResolvedValue({ ok: false, error: { code, message } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.respond).toHaveBeenCalledWith({
      conversationId: 'session-1', itemId: 'ask-1', kind: 'permission', by: 'desktop', optionId: 'decline',
    });
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: message, variant: 'destructive' });
  });

  it.each([true, false])('keeps a resolved answer silent (accepted=%s)', async (accepted) => {
    mocks.respond.mockResolvedValue({ ok: true, value: { accepted, settlement: { ...ask, state: 'resolved' } } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('keeps the no-longer-waiting notice for a withdrawn ask', async () => {
    mocks.respond.mockResolvedValue({ ok: true, value: { accepted: false, settlement: { ...ask, state: 'cancelled' } } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: 'extensions.consentNoLongerWaiting' });
  });

  it('keeps transport errors on the same destructive toast path', async () => {
    mocks.respond.mockRejectedValue(new Error('Host disconnected'));
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: 'Host disconnected', variant: 'destructive' });
  });

  it('closing the install sheet sends no answer and shows no error', async () => {
    mocks.sheet.mockResolvedValue({ outcome: 'dismissed' });
    await act(async () => band!.resolve('install'));
    expect(mocks.respond).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
