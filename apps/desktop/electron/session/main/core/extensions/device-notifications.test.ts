import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRunContext } from '../../../../device-actions/catalog';
import { createExtrasFamily } from '../../../../device-actions/families/extras';
import { showDeviceNotification } from './extension-notifications';

const { settings, shown } = vi.hoisted(() => ({
  settings: { enabled: true, sound: true },
  shown: [] as { title: string; body: string; silent: boolean }[],
}));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: async () => settings } }));
vi.mock('electron', () => ({ Notification: class {
  static isSupported() { return true; }
  constructor(private options: { title: string; body: string; silent: boolean }) {}
  show() { shown.push(this.options); }
} }));

let clock = 1_000_000;
beforeEach(() => {
  clock += 120_000;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  settings.enabled = true;
  settings.sound = true;
  shown.length = 0;
});

afterEach(() => vi.restoreAllMocks());

const family = createExtrasFamily();
const ctx = { deps: { notify: showDeviceNotification } } as ActionRunContext;
const notify = () => family.actions.find((action) => action.name === 'notification.show')!.run({ title: 'Please review', body: 'Question' }, ctx);

describe('device banners use the shared task preferences and limiter', () => {
  it('returns the actual disabled receipt through notification.show', async () => {
    settings.enabled = false;
    expect(await notify()).toEqual({ ok: true, data: { shown: false } });
    expect(shown).toEqual([]);
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
    await family.groups.find((group) => group.id === 'notification')!.probe!(ctx);
    expect(shown).toHaveLength(11);
    settings.enabled = false;
    await family.groups.find((group) => group.id === 'notification')!.probe!(ctx);
    expect(shown).toHaveLength(11);
  });
});
