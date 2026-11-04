import { describe, expect, it } from 'vitest';
import { migratedNotificationSettings } from './notification-settings';

describe('notification preference migration', () => {
  it('preserves an old OS-banner opt-out even when enabled was omitted from the stored delta', () => {
    expect(migratedNotificationSettings({ osNotifications: false })).toEqual({ enabled: false, sound: true });
    expect(migratedNotificationSettings({ enabled: true, osNotifications: false, sound: false })).toEqual({ enabled: false, sound: false });
  });

  it('preserves the two preferences and drops every legacy field', () => {
    expect(migratedNotificationSettings({ enabled: false, sound: false, osNotifications: true, customSoundPath: '/tone.wav', soundFocusMode: 'unfocused' }))
      .toEqual({ enabled: false, sound: false });
    expect(migratedNotificationSettings({ customSoundPath: '' })).toEqual({ enabled: true, sound: true });
  });

  it('leaves new installs and already migrated settings alone', () => {
    for (const raw of [null, undefined, {}, { enabled: false, sound: true }]) {
      expect(migratedNotificationSettings(raw)).toBeNull();
    }
  });
});
