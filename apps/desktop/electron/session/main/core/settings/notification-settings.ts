/** Migrate a stored delta once, preserving the old OS-banner opt-out. */
export function migratedNotificationSettings(raw: unknown): { enabled: boolean; sound: boolean } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!['osNotifications', 'customSoundPath', 'soundFocusMode'].some((key) => key in row)) return null;
  return { enabled: row.enabled !== false && row.osNotifications !== false, sound: row.sound !== false };
}
