import { verifiedFileHandle } from '../../../../../../tests/support/verifiedFileHandle';
import { describe, expect, it } from 'vitest';
import { attachmentInstallPlan, couldUpdateUnasked, messagePackageSource, resolveAttachmentPackage, type InstalledApp, type PackageMessageRow, type PackageReads } from './attachment-install';
import { EXTENSION_API_VERSION, parseExtensionManifest, type ExtensionManifest } from './manifest';

// The one answer the desktop (main) and the phone (L9) install a chat package by. main's own suite
// (extension-attachment-install.test.ts) runs the same rules end to end, unchanged, before and after they moved here.

const SUPABASE = 'https://db.example.test';
const ALICE = '11111111-2222-4333-8444-555555555555';
const MALLORY = '99999999-8888-4777-8666-555555555555';
const url = (uploader: string) => `${SUPABASE}/storage/v1/object/public/chat-media/${uploader}/notes.guguext`;

function manifest(version: string, capabilities: string[] = []): ExtensionManifest {
  return parseExtensionManifest({
    id: 'notes',
    name: 'Notes',
    version,
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    permissions: { capabilities },
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  });
}

const installedBy = (publisher: InstalledApp['publisher'], version = '1.0.0', capabilities: string[] = []): InstalledApp => ({
  manifest: manifest(version, capabilities),
  origin: 'attachment',
  publisher,
  revokedPermissions: [],
});

describe('attachmentInstallPlan: what may be installed, and what is asked first', () => {
  const plan = (candidate: ExtensionManifest, installed: InstalledApp | undefined, publisher = ALICE) =>
    attachmentInstallPlan({ candidate, publisher, installed });

  it('a first install asking for nothing goes in on the click; asking for anything, it asks about all of it', () => {
    expect(plan(manifest('1.0.0'), undefined)).toEqual({ kind: 'install' });
    expect(plan(manifest('1.0.0', ['files:write']), undefined)).toEqual({ kind: 'ask', installed: undefined, revokedPermissions: [] });
  });

  it('E-05: never replaces a folder, market or preinstalled App', () => {
    for (const origin of ['folder', 'market', 'preinstalled', undefined] as const) {
      expect(plan(manifest('2.0.0'), { ...installedBy({ id: ALICE, name: 'Alice' }), origin })).toMatchObject({
        kind: 'refuse',
        from: origin,
        installedVersion: '1.0.0',
      });
    }
  });

  it('the same publisher: an update asking for nothing new goes in; asking for more, it asks only about that', () => {
    const v1 = installedBy({ id: ALICE, name: 'Alice' }, '1.0.0', ['files:read']);
    expect(plan(manifest('1.1.0', ['files:read']), v1)).toEqual({ kind: 'install' });
    expect(plan(manifest('1.1.0', ['files:read', 'files:write']), v1)).toEqual({
      kind: 'ask',
      installed: v1.manifest,
      revokedPermissions: [],
    });
  });

  it('摩擦单 F66: another publisher under the same id asks in full and says whom it replaces', () => {
    const alices = installedBy({ id: ALICE, name: 'Alice' }, '1.0.0', ['files:read']);
    // Mallory's card asks for nothing new — still the full ask, like a first install.
    expect(plan(manifest('9.0.0', ['files:read']), alices, MALLORY)).toEqual({
      kind: 'ask',
      installed: undefined,
      revokedPermissions: [],
      replaces: 'Alice',
    });
    // Control: Alice's own next card, asking for nothing new, goes straight in.
    expect(plan(manifest('1.1.0', ['files:read']), alices, ALICE)).toEqual({ kind: 'install' });
  });

  it('an App installed before publishers were kept counts as someone else: asked in full, whom unknown', () => {
    expect(plan(manifest('1.1.0'), installedBy(null))).toEqual({ kind: 'ask', installed: undefined, revokedPermissions: [], replaces: null });
  });
});

describe('摩擦单 F66 unasked — nobody clicked: only an update of the App of this identity, later, asking nothing new', () => {
  const v1 = installedBy({ id: ALICE, name: 'Alice' }, '1.0.0', ['files:read']);
  const decide = (candidate: ExtensionManifest, installed: InstalledApp | undefined, publisher: string, unasked: boolean) =>
    attachmentInstallPlan({ candidate, publisher, installed, unasked });

  it('the same publisher, a later version, nothing new asked: it goes in', () => {
    expect(decide(manifest('1.1.0', ['files:read']), v1, ALICE, true)).toEqual({ kind: 'install' });
  });

  it('anything else is held — nothing asked, nothing installed — where the same card clicked installs, asks or refuses', () => {
    const cases: [string, ExtensionManifest, InstalledApp | undefined, string][] = [
      ['not here: a first install', manifest('1.0.0'), undefined, ALICE],
      ['the same version', manifest('1.0.0', ['files:read']), v1, ALICE],
      ['an older version', manifest('0.9.0', ['files:read']), v1, ALICE],
      ['asks for more', manifest('1.1.0', ['files:read', 'files:write']), v1, ALICE],
      ['another publisher', manifest('1.1.0', ['files:read']), v1, MALLORY],
      ['not from a chat (E-05)', manifest('1.1.0', ['files:read']), { ...v1, origin: 'folder' }, ALICE],
      ['no publisher kept', manifest('1.1.0'), installedBy(null), ALICE],
    ];
    for (const [why, candidate, installed, publisher] of cases) {
      expect({ why, plan: decide(candidate, installed, publisher, true) }).toEqual({ why, plan: { kind: 'held' } });
      // Control: clicked, the same card is never held.
      expect({ why, kind: decide(candidate, installed, publisher, false).kind }).not.toEqual({ why, kind: 'held' });
    }
  });
});

describe('摩擦单 F66 couldUpdateUnasked — before anything is downloaded: only an App here from a card, of that identity', () => {
  const v1 = installedBy({ id: ALICE, name: 'Alice' });

  it('its publisher: yes; anyone else, or no card App of theirs here: no', () => {
    expect(couldUpdateUnasked(ALICE, [v1])).toBe(true);
    expect(couldUpdateUnasked(MALLORY, [v1])).toBe(false);
    expect(couldUpdateUnasked(ALICE, [installedBy(null)])).toBe(false);
    expect(couldUpdateUnasked(ALICE, [])).toBe(false);
    // Her own computer: the App came from a folder, and her agent sends a card — the plan would hold it (E-05), so it is
    // not even downloaded.
    expect(couldUpdateUnasked(ALICE, [{ ...v1, origin: 'folder' }])).toBe(false);
  });
});

describe('#7290 a card by its message: the publisher is its sender, never the manifest\'s', () => {
  const ITEM = '44444444-4444-4444-8444-444444444444';
  const BLOB = '55555555-5555-4555-8555-555555555555';
  const card = (over: Partial<PackageMessageRow> = {}): PackageMessageRow => ({
    id: 'm1',
    content: '[附件] notes.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file',
    file_item_id: ITEM,
    file_version: 2,
    file_blob_id: null,
    sender_user_id: ALICE.toUpperCase(),
    ...over,
  });
  const reads = (row: PackageMessageRow | null, readable = true): PackageReads & { asked: unknown[] } => {
    const asked: unknown[] = [];
    return { asked, message: async () => row, open: async (source) => (asked.push(source), readable ? verifiedFileHandle(new Uint8Array([7])) : null) };
  };

  it('a new card in the folder: its item and version, published by its sender', () => {
    expect(messagePackageSource(card())).toEqual({ publisher: ALICE, source: { kind: 'item', itemId: ITEM, version: 2 } });
  });

  it('a whisper\'s card points at its bytes by the message', () => {
    expect(messagePackageSource(card({ file_item_id: null, file_version: null, file_blob_id: BLOB }))).toEqual({ publisher: ALICE, source: { kind: 'message', messageId: 'm1' } });
  });

  it('an old card by its message: published by its sender (whoever uploaded the bytes its text names), its bytes signed for the message — never the URL its text carries', () => {
    const old = card({ content: `[附件] notes.guguext (application/vnd.gugu.extension+zip)\n[URL] ${url(ALICE)}\n[Size] 9\n[Kind] file`, file_item_id: null, file_version: null, sender_user_id: MALLORY });
    expect(messagePackageSource(old)).toEqual({ publisher: MALLORY, source: { kind: 'message', messageId: 'm1' } });
  });


  it('refused, said why: its sender deleted their account, the file deleted from the folder, not a package', () => {
    expect(messagePackageSource(card({ sender_user_id: null }))).toEqual({ problem: expect.stringMatching(/deleted their account/) });
    expect(messagePackageSource(card({ file_item_id: null }))).toEqual({ problem: expect.stringMatching(/deleted from the group folder/) });
    expect(messagePackageSource(card({ content: '[附件] notes.pdf (application/pdf)\n[Size] 9\n[Kind] file' }))).toEqual({ problem: expect.stringMatching(/no App package/) });
  });

  it('resolveAttachmentPackage: reads the message and signs its bytes; unreadable or gone throws', async () => {
    const some = reads(card());
    const found = await resolveAttachmentPackage({ messageId: 'm1' }, some);
    expect(found.publisher).toBe(ALICE); expect(found.file).toMatchObject({ purpose: 'file' });
    expect(await found.file.read(0, 1)).toEqual(new Uint8Array([7])); await found.file.dispose();
    expect(some.asked).toEqual([{ kind: 'item', itemId: ITEM, version: 2 }]);
    await expect(resolveAttachmentPackage({ messageId: 'm1' }, reads(null))).rejects.toThrow(/no message m1 you can read/);
    await expect(resolveAttachmentPackage({ messageId: 'm1' }, reads(card(), false))).rejects.toThrow(/no longer there/);
  });

});
