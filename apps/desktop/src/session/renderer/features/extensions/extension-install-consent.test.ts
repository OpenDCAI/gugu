import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_CONSENT_ANSWER_EVENT,
  EXTENSION_CONSENT_EVENT,
  EXTENSION_INSTALL_CONSENT_CLOSE_METHOD,
  EXTENSION_INSTALL_CONSENT_METHOD,
  type ExtensionConsentEventDetail,
  type ExtensionInstallConsentRequest,
} from '@shared/extensions/host-actions';
import {
  EXTENSION_API_VERSION,
  newlyReachableHosts,
  parseExtensionManifest,
} from '@shared/extensions/manifest';

const consentPrompt = vi.fn(() => ({
  title: 'Install Reader?',
  description: 'Workspace read',
  confirmLabel: 'Install',
  variant: 'default' as const,
}));

// The words are judged in extension-consent.test.ts; here only what this layer adds to them (the real `withMarketSource`).
vi.mock('@renderer/features/extensions/extension-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/extensions/extension-consent')>()),
  consentPrompt,
}));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, params?: Record<string, string>) =>
    params ? `${key}:${Object.values(params).join('|')}` : key,
}));
vi.mock('@shared/extensions/manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/extensions/manifest')>();
  return { ...actual, safeParseExtensionManifest: (manifest: unknown) => ({ ok: true, manifest }) };
});
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));
vi.mock('./extension-surface-store', () => ({
  extensionSurfaceStore: { say: vi.fn() },
}));

const { extensionHostActionHandlers } = await import('./host-action-handlers');

const request: ExtensionInstallConsentRequest = {
  sourceDir: '/tmp/reader',
  manifestDigest: 'digest-a',
  revokedPermissions: [],
  manifest: {
    id: 'reader',
    name: 'Reader',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'main.html',
    permissions: { capabilities: ['files:read'] },
    contributes: { tabs: [{ name: 'main', title: 'Read', entry: 'main.html' }] },
  },
};

type Ask = Extract<ExtensionConsentEventDetail, { type: 'ask' }>;
const ask = (detail: Partial<ExtensionInstallConsentRequest> = {}) =>
  extensionHostActionHandlers[EXTENSION_INSTALL_CONSENT_METHOD]!({ ...request, ...detail }) as Promise<{ outcome: string }>;
const answer = (requestId: string, outcome: string) =>
  window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_ANSWER_EVENT, { detail: { requestId, outcome } }));
const stillOpen = { outcome: 'still open' };
const settled = (promise: Promise<unknown>) => Promise.race([promise, Promise.resolve(stillOpen)]);

// These run without a DOM: the window is an event target, and the shell's sheet is a listener that takes each ask.
const revealed = vi.fn();
let events: ExtensionConsentEventDetail[] = [];
let shellTakes = true;
beforeEach(() => {
  const win = new EventTarget();
  win.addEventListener('__sessionpage_reveal', revealed);
  win.addEventListener(EXTENSION_CONSENT_EVENT, (event) => {
    const detail = (event as CustomEvent<ExtensionConsentEventDetail>).detail;
    events.push(detail);
    if (detail.type === 'ask' && shellTakes) detail.shown = true;
  });
  vi.stubGlobal('window', win);
  revealed.mockClear();
  consentPrompt.mockClear();
  events = [];
  shellTakes = true;
});

describe('extension installation consent contract', () => {
  it('shows the declared permissions before confirming an install; the yes comes back', async () => {
    const promise = ask();
    const shown = events[0] as Ask;
    // Asked on the computer it installs on: no other computer named (D-31).
    expect(consentPrompt).toHaveBeenCalledWith(undefined, [], request.manifest, expect.any(Function), expect.any(String), undefined, undefined);
    answer(shown.requestId, 'confirmed');
    await expect(promise).resolves.toEqual({ outcome: 'confirmed' });
  });

  it('asks again only for a newly reachable host on upgrade', () => {
    const manifest = (network: string[]) =>
      parseExtensionManifest({
        id: 'reader',
        name: 'Reader',
        version: '1.1.0',
        apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
        entry: 'main.html',
        permissions: { network },
        contributes: { tabs: [{ name: 'main', title: 'Read' }] },
      });

    expect(newlyReachableHosts(['a.example.com'], manifest(['a.example.com', 'b.example.com']))).toEqual([
      'b.example.com',
    ]);
  });

  it('a closed sheet is a dismissal, and Cancel is a no from the person: neither installs', async () => {
    const first = ask();
    answer((events[0] as Ask).requestId, 'dismissed');
    await expect(first).resolves.toEqual({ outcome: 'dismissed' });
    const second = ask();
    answer((events[1] as Ask).requestId, 'declined');
    await expect(settled(second)).resolves.toEqual({ outcome: 'declined' });
  });

  it('asks where the person is: the shell sheet takes it, the view never changes, its answer settles it (摩擦单 F6)', async () => {
    const promise = ask();
    const shown = events[0] as Ask;
    expect(shown).toMatchObject({ type: 'ask', title: 'Install Reader?', description: 'Workspace read', confirmLabel: 'Install' });
    expect(revealed).not.toHaveBeenCalled();
    // Control: an answer to another ask does not settle this one.
    answer('another', 'confirmed');
    await expect(settled(promise)).resolves.toEqual(stillOpen);
    answer(shown.requestId, 'declined');
    await expect(promise).resolves.toEqual({ outcome: 'declined' });
  });

  it('no sheet to ask with is a failure, never a switch to the session page (D-31: that fallback is gone)', () => {
    shellTakes = false;
    expect(() => ask()).toThrow('No consent sheet in this window');
    expect(revealed).not.toHaveBeenCalled();
  });

  it("names a chat package's sender, and gives up after the one consent window (#6646)", async () => {
    vi.useFakeTimers();
    const promise = ask({ attachment: { from: 'Bob' } });
    expect((events[0] as Ask).description).toBe('extensions.consentFromAttachment:Bob\n\nWorkspace read');
    await vi.advanceTimersByTimeAsync(279_999);
    await expect(settled(promise)).resolves.toEqual(stillOpen);
    await vi.advanceTimersByTimeAsync(1);
    // Read whether it has settled, not wait for it: a sheet that does not close here would hang the run.
    await expect(settled(promise)).resolves.toEqual({ outcome: 'timeout' });
    expect(events.at(-1)).toEqual({ type: 'close', requestId: (events[0] as Ask).requestId });
  });

  // 复核 10-15: another publisher's package that would replace the one installed — on the machine it installs on. Asked from
  // here for another machine, the sentence names that machine (the one replaced is there), not this computer.
  it("another publisher's package replacing one: the sentence names the computer it is on — this one, or the one picked", () => {
    void ask({ attachment: { from: 'Bob', replaces: 'Ann' }, machine: 'Mac 1' });
    expect((events[0] as Ask).description).toContain('extensions.consentOtherPublisher:Bob|Ann|extensions.permissionsOnMachine:Mac 1');
    void ask({ attachment: { from: 'Bob', replaces: '' } });
    expect((events[1] as Ask).description).toContain('extensions.consentOtherPublisherUnknown:Bob|extensions.permissionsThisComputer');
  });

  it('an App from the market: the first line says it came from the market', () => {
    void ask({ market: { source: { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) } } });
    expect((events[0] as Ask).description).toBe('extensions.consentFromMarket\n\nWorkspace read');
  });

  // D-31 An agent's install: the same ask as its approval in the agent's session — answered there first, the sheet here goes.
  it("an agent's ask keeps the host's id, says who asks, and ends unanswered here once main closes it", async () => {
    const promise = ask({ requestId: 'host-1', requester: { name: 'Claude 1', agentUserId: 'agent-1' } });
    const shown = events[0] as Ask;
    expect(shown.requestId).toBe('host-1');
    expect(shown.title).toBe('extensions.installConfirmTitleBy:Claude 1|Reader');
    expect(shown.requester).toEqual({ name: 'Claude 1', agentUserId: 'agent-1' });
    // Control: closing another ask leaves this one open.
    extensionHostActionHandlers[EXTENSION_INSTALL_CONSENT_CLOSE_METHOD]!({ requestId: 'host-2' });
    await expect(settled(promise)).resolves.toEqual(stillOpen);
    extensionHostActionHandlers[EXTENSION_INSTALL_CONSENT_CLOSE_METHOD]!({ requestId: 'host-1' });
    await expect(settled(promise)).resolves.toEqual({ outcome: 'timeout' });
    expect(events.at(-1)).toEqual({ type: 'close', requestId: 'host-1' });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});


it('fork removal names the App, device and slug, keeps program details and waits for a human', async () => {
  const details = { label: 'Commands', caption: 'Runs on this device', lines: ['node tools.mjs'] };
  consentPrompt.mockImplementationOnce(() => ({ title: 'Install Reader?', description: 'New program permission', confirmLabel: 'Install', variant: 'default', details }));
  const pending = ask({ machine: 'Remote host', removeVariant: { name: 'my-fork', active: true } });
  const shown = events[0] as Ask;
  expect(shown.title).toContain('my-fork|Reader|extensions.permissionsOnMachine:Remote host');
  expect(shown.description).toContain('extensions.removeActiveVariantBody');
  expect(shown.description).toContain('New program permission');
  expect(shown.details).toEqual(details);
  expect(shown.confirmLabel).toBe('extensions.removeVariantConfirm');
  expect(await settled(pending)).toEqual(stillOpen);
  answer(shown.requestId, 'declined');
  await expect(pending).resolves.toEqual({ outcome: 'declined' });
});
