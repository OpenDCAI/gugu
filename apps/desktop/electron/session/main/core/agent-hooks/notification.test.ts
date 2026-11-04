import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeShowNotification } from './notification';
import { setSessionAgentNotificationCopy } from './notification-copy';
import { setSystemNotificationsUsable } from './system-notifications';
import { log } from '@main/lib/logger';

const h = vi.hoisted(() => ({ settings: { enabled: true, sound: true }, banners: [] as { title: string; body: string; silent: boolean }[], systemUsable: vi.fn(async () => true) }));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: async () => h.settings } }));
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 's1', config: { version: '1', type: 'acp', agentDisplayName: 'Review' }, provider: 'codex' }] }) }) }) } }));
vi.mock('@main/core/agents/plugin-registry', () => ({ getPluginMetadata: () => ({ name: 'Codex' }) }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, Notification: class {
  constructor(options: { title: string; body: string; silent: boolean }) { h.banners.push(options); }
  on() {}
  show() {}
} }));

beforeEach(() => {
  vi.clearAllMocks();
  h.systemUsable.mockResolvedValue(true);
  setSystemNotificationsUsable(h.systemUsable);
  h.settings.enabled = true; h.settings.sound = true; h.banners.length = 0;
  setSessionAgentNotificationCopy({ needsApproval: 'Needs approval', needsAnswer: 'Needs an answer' });
});
const session = { sessionId: 's1', projectId: 'p1' };
const working = { status: 'working', detail: 'running' } as const;
const approval = { status: 'needs_user', detail: 'approval' } as const;

describe('agent banner owns its sound', () => {
  it.each([true, false])('uses sound=%s for an actual wait banner', async (sound) => {
    h.settings.sound = sound;
    await maybeShowNotification(session, working, approval);
    expect(h.banners).toEqual([{ title: 'Codex — Review', body: 'Needs approval', silent: !sound }]);
  });
  it('does not emit a banner or sound for a finished/error reading or a repeated wait', async () => {
    await maybeShowNotification(session, working, { status: 'idle', detail: 'done' });
    await maybeShowNotification(session, working, { status: 'error', detail: null });
    await maybeShowNotification(session, approval, approval);
    expect(h.banners).toEqual([]);
    expect(h.systemUsable).not.toHaveBeenCalled();
  });
  it('keeps sound and banners off together when disabled', async () => {
    h.settings.enabled = false;
    await maybeShowNotification(session, working, approval);
    expect(h.banners).toEqual([]);
  });
  it('does not construct a banner when the host gate is unavailable', async () => {
    h.systemUsable.mockResolvedValue(false);
    await maybeShowNotification(session, working, approval);
    expect(h.systemUsable).toHaveBeenCalledOnce();
    expect(h.banners).toEqual([]);
  });
  it('logs a missing host injection instead of bypassing the gate', async () => {
    vi.resetModules();
    const { maybeShowNotification: unwired } = await import('./notification');
    await unwired(session, working, approval);
    expect(h.banners).toEqual([]);
    expect(log.error).toHaveBeenCalledWith('notification: failed to show OS notification', {
      error: expect.stringContaining('never injected'),
    });
  });
});
