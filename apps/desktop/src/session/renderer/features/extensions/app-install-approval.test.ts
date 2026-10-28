// D-31 An agent's App install answered from this device — the session page's band (a chat-UI session's composer or a terminal
// session's terminal), the phone's card and the private chat's band all answer through `answerAppInstall`: only a 「装」 from
// the sheet that showed the App carries its fingerprint, which is the only install the host takes.
import { afterEach, describe, expect, it, vi } from 'vitest';

const askInShell = vi.fn();
vi.mock('./install-consent', () => ({ askInShell, installConsentPrompt: () => ({ title: 'Install Reader?' }) }));
vi.mock('@shared/extensions/manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/extensions/manifest')>();
  return { ...actual, safeParseExtensionManifest: (manifest: unknown) => ({ ok: true, manifest }) };
});

const { answerAppInstall, answeredTooLate, appInstallWords, sessionWaitsOnApproval } = await import('./app-install-approval');

const ask = {
  request: {
    requestId: 'ask-1',
    sourceDir: '/tmp/reader',
    manifest: { id: 'reader', name: 'Reader' },
    manifestDigest: 'digest-r',
    revokedPermissions: [],
    given: { first: true },
    requester: { name: 'Claude 6', agentUserId: 'agent-6' },
  },
} as never;

afterEach(() => askInShell.mockReset());

describe('an App install answered from this device (D-31)', () => {
  it('「不装」 answers at once: no sheet, no fingerprint', async () => {
    const respond = vi.fn(async () => ({ ok: true }));
    await answerAppInstall({ itemId: 'ask-1', ask, optionId: 'decline', respond });
    expect(askInShell).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ optionId: 'decline' });
  });

  it("「查看并安装」 opens this device's own sheet, naming the computer the session runs on; its 装 carries what it showed", async () => {
    askInShell.mockReturnValueOnce(Promise.resolve({ outcome: 'confirmed' }));
    const respond = vi.fn(async () => ({ ok: true }));
    await answerAppInstall({ itemId: 'ask-1', ask, optionId: 'install', machine: 'mac1', respond });
    const [, requestId, , given, requester, machine] = askInShell.mock.calls[0]!;
    expect({ requestId, given, requester, machine }).toEqual({
      requestId: 'ask-1',
      given: { first: true },
      requester: { name: 'Claude 6', agentUserId: 'agent-6' },
      machine: 'mac1',
    });
    expect(respond).toHaveBeenCalledWith({ optionId: 'install', digest: 'digest-r' });
  });

  it('a no on the sheet is a no; closing it answers nothing — the ask stays where it was', async () => {
    askInShell.mockReturnValueOnce(Promise.resolve({ outcome: 'declined' }));
    const declined = vi.fn(async () => ({ ok: true }));
    await answerAppInstall({ itemId: 'ask-1', ask, optionId: 'install', respond: declined });
    expect(declined).toHaveBeenCalledWith({ optionId: 'decline' });

    askInShell.mockReturnValueOnce(Promise.resolve({ outcome: 'dismissed' }));
    const closed = vi.fn();
    await expect(answerAppInstall({ itemId: 'ask-1', ask, optionId: 'install', respond: closed })).resolves.toBeUndefined();
    expect(closed).not.toHaveBeenCalled();
  });

  it('an answer that came after the ask was withdrawn is 「已经不等了」, not a failure — one beaten by another answer is not', () => {
    expect(answeredTooLate({ ok: true, value: { accepted: false, settlement: { state: 'cancelled' } } })).toBe(true);
    expect(answeredTooLate({ accepted: false, settlement: { state: 'cancelled' } })).toBe(true);
    expect(answeredTooLate({ ok: true, value: { accepted: false, settlement: { state: 'resolved' } } })).toBe(false);
    expect(answeredTooLate({ ok: true, value: { accepted: true, settlement: { state: 'resolved' } } })).toBe(false);
    expect(answeredTooLate(undefined)).toBe(false);
  });

  it("the band reads the session's timeline only while the session waits on an approval — an open panel reads nothing else", () => {
    expect(sessionWaitsOnApproval({ status: 'needs_user', detail: 'approval' })).toBe(true);
    expect(sessionWaitsOnApproval({ status: 'needs_user', detail: 'question' })).toBe(false);
    expect(sessionWaitsOnApproval({ status: 'working', detail: null })).toBe(false);
    expect(sessionWaitsOnApproval({ status: null, detail: null })).toBe(false);
    expect(sessionWaitsOnApproval(undefined)).toBe(false);
  });

  it('the band names the computer the session runs on, and the group an install on a narrowed computer adds (problem 8)', () => {
    const translate = (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join('|')}` : key);
    const forGroup = { request: { ...(ask as { request: object }).request, given: { first: false, chat: { id: 'g1', name: 'Ops' } } } } as never;
    expect(appInstallWords(forGroup, translate as never, 'Linux 1').title).toBe('extensions.installAskBandForGroup:Claude 6|Reader|extensions.permissionsOnMachine:Linux 1|Ops');
  });

  it('the band says who asks for what, and 「查看并安装」 / 「不装」', () => {
    const translate = (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join('|')}` : key);
    const words = appInstallWords(ask, translate as never);
    expect(words.title).toBe('extensions.installAskBand:Claude 6|Reader|extensions.permissionsThisComputer');
    expect([words.label('install'), words.label('decline'), words.label('other')]).toEqual([
      'extensions.consentAsk',
      'extensions.consentDeclineAction',
      undefined,
    ]);
  });
});
