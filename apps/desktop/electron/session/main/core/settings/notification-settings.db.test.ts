import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!h.db) throw new Error('fixture not open'); return h.db; } }));
vi.mock('@main/core/agents/plugin-registry', () => ({ isValidProviderId: () => true }));
import { SettingsStore } from './settings-service';

let fixture: Awaited<ReturnType<typeof openFixture>>;
afterEach(() => { fixture?.close(); h.db = undefined; });

describe('startup migration replaces the stored notification delta', () => {
  it.each([
    { old: { osNotifications: false }, expected: { enabled: false, sound: true }, stored: { enabled: false } },
    { old: { enabled: false, sound: false, osNotifications: true, customSoundPath: '/tone.wav', soundFocusMode: 'unfocused' }, expected: { enabled: false, sound: false }, stored: { enabled: false, sound: false } },
  ])('preserves the opt-out and physically removes legacy keys: $old', async ({ old, expected, stored }) => {
    fixture = await openFixture('empty'); h.db = fixture.db;
    fixture.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('notifications', JSON.stringify(old));
    const settings = new SettingsStore();
    await settings.initialize();
    expect(await settings.get('notifications')).toEqual(expected);
    const read = () => (fixture.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('notifications') as { value: string }).value;
    expect(JSON.parse(read())).toEqual(stored);
    const raw = read();
    await settings.initialize();
    expect(read()).toBe(raw);
  });
});
