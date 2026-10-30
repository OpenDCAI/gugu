import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ ready: vi.fn(), focus: vi.fn() }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ list: () => ({ extensions: [] }), isEnabled: () => true }),
}));
vi.mock('@main/core/extensions/extension-bridge', () => ({ bringSessionUp: host.focus }));
vi.mock('@main/core/extensions/extension-show-session', () => ({ sessionHere: async () => 'imported-project' }));
vi.mock('@main/core/extensions/extension-bridge-relay', () => ({
  actInWindow: async () => undefined, listedSessionProject: async () => null,
}));
vi.mock('@main/core/host-locale', () => ({ sessionHostLocale: () => 'en-US' }));
import { openLink, setSessionOpening } from '@main/core/extensions/gugu-links';

const target = { kind: 'session', projectId: 'remote-project', sessionId: 'existing-agent' } as const;
beforeEach(() => {
  vi.resetAllMocks();
  host.ready.mockResolvedValue(undefined);
  setSessionOpening({ agentSession: async () => null, ensureReady: host.ready });
});
afterEach(() => setSessionOpening(null));

it('carries the group receipt through main authorization and project alias resolution', async () => {
  await expect(openLink(target, 'group-request-id')).resolves.toMatchObject({ kind: 'opened' });
  expect(host.ready).toHaveBeenCalledWith(target.sessionId);
  expect(host.focus).toHaveBeenCalledExactlyOnceWith({ projectId: 'imported-project', sessionId: target.sessionId, groupParticipantRequestId: 'group-request-id' });
});

it('leaves ordinary task focus untagged', async () => {
  await expect(openLink(target)).resolves.toMatchObject({ kind: 'opened' });
  expect(host.focus).toHaveBeenCalledExactlyOnceWith({ projectId: 'imported-project', sessionId: target.sessionId });
});

it('emits no receipt when host readiness fails before focus', async () => {
  host.ready.mockRejectedValue(new Error('host unavailable'));
  await expect(openLink(target, 'failed-request-id')).resolves.toMatchObject({ kind: 'failed' });
  expect(host.focus).not.toHaveBeenCalled();
});
