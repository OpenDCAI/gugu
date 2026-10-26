import { describe, expect, it, vi } from 'vitest';
import { IN_FILTER_CHUNK } from '@gugu/core/shared/inChunks';

/**
 * #6913 / L11 复核 49 (measured on the test DB's 112-person group 大群-muipv9di): main read a chat's members' identities in
 * one `.in('id', …)` — past ~88 ids the gateway answers 502 (@@@1666), so a page in that group had no `members` at all
 * (and since #6913 reads chat and members together, no context). Main now reads them in chunks, as the window does.
 * Control (the parent commit): one request with all 113 ids.
 */

type Platform = { identities(token: string, ids: readonly string[]): Promise<readonly { id: string }[]> };
let platform: Platform | null = null;
const asked: string[][] = [];

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({}) }));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()), currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, fileServiceUrl: () => 'http://files.invalid', localFileService: {} }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => {
          asked.push(ids);
          return { data: ids.map((id) => ({ id, display_name: id, avatar: null, type: 'human', owner_user_id: null })), error: null };
        },
      }),
    }),
  }),
}));
vi.mock('@shared/extensions/app-files-core', async (original) => ({
  ...(await original<typeof import('@shared/extensions/app-files-core')>()),
  createAppFiles: (given: Platform) => {
    platform = given;
    return {};
  },
}));

await import('./app-files');

describe("a big group's members (identities read by main)", () => {
  it('113 people are read in chunks the gateway takes, and every one comes back', async () => {
    const ids = Array.from({ length: 113 }, (_, i) => `0a000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const people = await platform!.identities('token', ids);
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((chunk) => chunk.length <= IN_FILTER_CHUNK)).toBe(true);
    expect(people.map((person) => person.id).sort()).toEqual([...ids].sort());
  });
});
