import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRunContext } from '../../../../device-actions/catalog';
import { createExtrasFamily } from '../../../../device-actions/families/extras';
import { showDeviceNotification } from './extension-notifications';

const { settings, shown, state, instances, log } = vi.hoisted(() => ({
  settings: { enabled: true, sound: true },
  shown: [] as { title: string; body: string; silent: boolean }[],
  state: { autoShow: true },
  instances: [] as { emit(event: string, ...args: unknown[]): boolean }[],
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: async () => settings } }));
vi.mock('@main/lib/logger', () => ({ log }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { Notification: class extends EventEmitter {
    static isSupported() { return true; }
    constructor(private options: { title: string; body: string; silent: boolean }) { super(); instances.push(this); }
    show() { shown.push(this.options); if (state.autoShow) this.emit('show'); }
    close() { this.emit('close'); }
  } };
});

let clock = 1_000_000;
beforeEach(() => {
  clock += 120_000;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  settings.enabled = true;
  settings.sound = true;
  shown.length = 0;
  instances.length = 0;
  state.autoShow = true;
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

const family = createExtrasFamily();
const ctx = { deps: { notify: showDeviceNotification } } as ActionRunContext;
const notify = () => family.actions.find((action) => action.name === 'notification.show')!.run({ title: 'Please review', body: 'Question' }, ctx);
const probe = () => family.groups.find((group) => group.id === 'notification')!.probe!(ctx);

describe('device banners use the shared task preferences and limiter', () => {
  it('returns the actual disabled receipt through notification.show', async () => {
    settings.enabled = false;
    expect(await notify()).toEqual({ ok: true, data: { shown: false } });
    expect(shown).toEqual([]);
  });

  it('fails the user-pressed probe explicitly when notifications are disabled', async () => {
    settings.enabled = false;
    expect(await probe()).toEqual({
      ok: false, code: 'execution_failed',
      message: 'Notifications are turned off in gugu settings or are not supported on this computer.',
    });
    expect(shown).toEqual([]);
  });

  it('waits for the actual system show event before reporting shown:true', async () => {
    state.autoShow = false;
    const receipt = notify();
    let settled = false;
    void receipt.then(() => { settled = true; });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(settled).toBe(false);
    instances[0]!.emit('show');
    expect(await receipt).toEqual({ ok: true, data: { shown: true } });
    expect(log.info).toHaveBeenCalledWith('notification: device banner shown', { title: 'Please review' });
  });

  it('reports and logs the system refusal instead of claiming a banner was shown', async () => {
    state.autoShow = false;
    const refused = expect(notify()).rejects.toThrow('the system does not allow gugu to show notifications');
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    instances[0]!.emit('failed', {}, 'UNErrorDomain 1');
    await refused;
    expect(log.warn).toHaveBeenCalledWith('notification: OS refused device banner', { error: 'UNErrorDomain 1' });
  });

  it('makes sound a property of the banner', async () => {
    await notify();
    expect(shown[0]).toMatchObject({ silent: false });
    settings.sound = false;
    await notify();
    expect(shown[1]).toMatchObject({ silent: true });
  });

  it('refuses the eleventh banner but not the user-pressed probe, which still obeys the gate', async () => {
    for (let i = 0; i < 10; i++) await notify();
    await expect(notify()).rejects.toThrow('too many banners: at most 10 a minute');
    expect(shown).toHaveLength(10);
    expect(await probe()).toEqual({ ok: true, data: null });
    expect(shown).toHaveLength(11);
    settings.enabled = false;
    expect(await probe()).toMatchObject({ ok: false, code: 'execution_failed' });
    expect(shown).toHaveLength(11);
  });
});
