import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';

// #6646 A .guguext sent in chat is installed by main from the bytes it downloads itself, through the same consent.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://db.test' }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
// The identity directory, as main reads it (app-files.ts readAccount): Alice, Mallory, and Alice's agent.
const directory = vi.hoisted(() => ({
  '0a000000-0000-4000-8000-00000000000a': { type: 'human', owner_user_id: null, display_name: 'Alice' },
  '0b000000-0000-4000-8000-00000000000b': { type: 'human', owner_user_id: null, display_name: 'Mallory' },
  '0c000000-0000-4000-8000-00000000000c': { type: 'agent', owner_user_id: '0a000000-0000-4000-8000-00000000000a', display_name: 'Claude 3' },
} as Record<string, { type: string; owner_user_id: string | null; display_name: string }>));
// #7290 Cards by their message, as main reads them as the signed-in person (app-files.ts packageReads): the row the
// server keeps (its publisher among it), and the link attachments/urls signs for its bytes.
const cards = vi.hoisted(() => ({ rows: {} as Record<string, unknown>, signed: [] as unknown[] }));
vi.mock('./app-files', () => ({
  readAccount: async (id: string) => directory[id] ?? null,
  packageReads: {
    message: async (id: string) => cards.rows[id] ?? null,
    sign: async (source: unknown) => (cards.signed.push(source), 'https://cdn.test/ab/abab?auth_key=1'),
  },
}));

const { installExtensionFromAttachment } = await import('./extension-attachment-install');

// Who published a card is the one who sent it, the message's sender (#7290, owner 10-17; 摩擦单 F66).
const ALICE = '0a000000-0000-4000-8000-00000000000a';
const MALLORY = '0b000000-0000-4000-8000-00000000000b';
const ALICE_AGENT = '0c000000-0000-4000-8000-00000000000c';
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
const folderCard = (id: string, publisher: string) => ({
  id,
  content: '[附件] share.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file',
  file_item_id: '44444444-4444-4444-8444-444444444444',
  file_version: 1,
  file_blob_id: null,
  sender_user_id: publisher,
});

let work: string;
let service: ExtensionsService;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-6646-attach-'));
  state.userData = path.join(work, 'userData');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
  cards.rows = { 'm-agent': folderCard('m-agent', ALICE_AGENT), 'm-alice': folderCard('m-alice', ALICE), 'm-mallory': folderCard('m-mallory', MALLORY) };
  cards.signed = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(work, { recursive: true, force: true });
});

/** Packs a bundle and serves its bytes as the attachment download. */
async function sendInChat(id: string, permissions?: { network: string[] }, version = '1.0.0') {
  const dir = path.join(work, 'src', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: 'Share', version, apiVersion: EXTENSION_API_VERSION, entry: 'index.html',
    ...(permissions ? { permissions } : {}), contributes: { tabs: [{ name: 'main', title: 'Share' }] },
  }));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const fetch = vi.fn(async () => new Response(new Uint8Array(bytes)));
  vi.stubGlobal('fetch', fetch);
  return { dir, sha256, fetch };
}


describe('#7290 a card in the group folder, installed by its message', () => {

  it('the publisher is the card\'s sender — her agent\'s card is Alice\'s; the bytes come from the link signed for it', async () => {
    const { fetch } = await sendInChat('share');
    await installExtensionFromAttachment({ messageId: 'm-agent' }, quiet);
    expect(service.publishers()).toEqual({ share: { id: ALICE, name: 'Alice' } });
    expect(cards.signed).toEqual([{ kind: 'item', itemId: '44444444-4444-4444-8444-444444444444', version: 1 }]);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://cdn.test/ab/abab?auth_key=1');
    // Her own card, nothing new: an update of hers, no prompt.
    await sendInChat('share');
    const requestInstallConsent = vi.fn();
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent })).resolves.toMatchObject({ installed: true });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    // Mallory's card of the same id is Mallory's — a forward of Alice's package too (owner 10-17): asked in full (E-05), saying whose it replaces.
    await sendInChat('share');
    const asked = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await installExtensionFromAttachment({ messageId: 'm-mallory' }, { ...quiet, requestInstallConsent: asked });
    expect(asked.mock.calls[0]![0]).toMatchObject({ installed: undefined, attachment: { from: 'Mallory', replaces: 'Alice' } });
  });

  it('a message the person cannot read, or one whose sender deleted their account, is refused before anything is downloaded', async () => {
    const { fetch } = await sendInChat('share');
    await expect(installExtensionFromAttachment({ messageId: 'm-none' }, quiet)).rejects.toThrow(/no message m-none you can read/);
    cards.rows['m-gone-sender'] = { ...folderCard('m-gone-sender', ALICE), sender_user_id: null };
    await expect(installExtensionFromAttachment({ messageId: 'm-gone-sender' }, quiet)).rejects.toThrow(/deleted their account/);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.list().extensions).toEqual([]);
  });
});

describe('installing an extension package from chat (#6646)', () => {
  it('an update asks only when it asks for more, and only about that (摩擦单 F21)', async () => {
    // The version installed came from a card: its uploader is on record as the publisher (摩擦单 F66).
    await sendInChat('share');
    await installExtensionFromAttachment({ messageId: 'm-alice' }, quiet);
    await sendInChat('share', { network: ['api.example.com'] });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    expect(requestInstallConsent.mock.calls[0]![0].installed?.id).toBe('share');
    // Control: the same package again with nothing new is not asked about.
    await sendInChat('share');
    const again = vi.fn();
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent: again }))
      .resolves.toMatchObject({ installed: true });
    expect(again).not.toHaveBeenCalled();
  });

  it('an update from another publisher is asked in full, saying whose it replaces — never one click (摩擦单 F66)', async () => {
    await sendInChat('share');
    await installExtensionFromAttachment({ messageId: 'm-alice' }, quiet);
    expect(service.publishers()).toEqual({ share: { id: ALICE, name: 'Alice' } });
    // Mallory sends the same id, asking for nothing new.
    await sendInChat('share');
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await expect(installExtensionFromAttachment({ messageId: 'm-mallory' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    // In full (no installed version to diff against), with who it replaces.
    expect(requestInstallConsent.mock.calls[0]![0]).toMatchObject({ installed: undefined, attachment: { from: 'Mallory', replaces: 'Alice' } });
    expect(service.publishers().share?.id).toBe(ALICE);
    // Control: Alice's own next card, nothing new — no prompt. Before F66 Mallory's went exactly this way.
    await sendInChat('share');
    const again = vi.fn();
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent: again }))
      .resolves.toMatchObject({ installed: true });
    expect(again).not.toHaveBeenCalled();
  });

  it('a package her agent sent is Alice’s: recorded under her, by her own name, and her own next card is an update of it', async () => {
    await sendInChat('share');
    await installExtensionFromAttachment({ messageId: 'm-agent' }, quiet);
    expect(service.publishers()).toEqual({ share: { id: ALICE, name: 'Alice' } });
    // Alice's own card, nothing new: the same publisher, so no prompt (摩擦单 F66).
    await sendInChat('share');
    const requestInstallConsent = vi.fn();
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: true });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    // Control: Mallory's card of the same id is someone else's, asked in full.
    await sendInChat('share');
    const asked = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await installExtensionFromAttachment({ messageId: 'm-mallory' }, { ...quiet, requestInstallConsent: asked });
    expect(asked.mock.calls[0]![0]).toMatchObject({ installed: undefined, attachment: { from: 'Mallory', replaces: 'Alice' } });
  });

  it('installs a package that asks for nothing without asking, records it as from chat, and leaves no staging', async () => {
    const { fetch } = await sendInChat('share');
    const requestInstallConsent = vi.fn();
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: true, id: 'share' });
    expect(requestInstallConsent).not.toHaveBeenCalled();
    // The download has a deadline: the consent window only starts after it.
    expect((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
    expect(service.origins()).toEqual({ share: 'attachment' });
    expect(readdirSync(path.join(state.userData, 'extension-attachments'))).toEqual([]);
  });

  it('asks, naming the publisher as the identity directory does, for a package that declares permissions', async () => {
    await sendInChat('share', { network: ['example.com'] });
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'declined' });
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: false, outcome: 'declined' });
    expect(requestInstallConsent.mock.calls[0]![0].attachment).toEqual({ from: 'Alice' });
    expect(service.list().extensions).toEqual([]);
  });

  it('摩擦单 F66 unasked: a later version from the same publisher asking nothing new goes in; anything else is held — never a dialog', async () => {
    await sendInChat('share');
    await installExtensionFromAttachment({ messageId: 'm-alice' }, quiet);
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    const dependencies = { ...quiet, requestInstallConsent };
    const installedVersion = () => service.list().extensions.find((entry) => entry.manifest.id === 'share')?.manifest.version;
    await sendInChat('share', { network: ['api.example.com'] }, '1.1.0');
    await expect(installExtensionFromAttachment({ messageId: 'm-alice', unasked: true }, dependencies))
      .resolves.toMatchObject({ installed: false, outcome: 'held', version: '1.1.0' });
    // Mallory published nothing here: held before a byte is downloaded.
    const { fetch } = await sendInChat('share', undefined, '1.1.0');
    await expect(installExtensionFromAttachment({ messageId: 'm-mallory', unasked: true }, dependencies))
      .resolves.toEqual({ installed: false, outcome: 'held' });
    expect(fetch).not.toHaveBeenCalled();
    expect(requestInstallConsent).not.toHaveBeenCalled();
    expect(installedVersion()).toBe('1.0.0');
    await expect(installExtensionFromAttachment({ messageId: 'm-alice', unasked: true }, dependencies))
      .resolves.toMatchObject({ installed: true, version: '1.1.0', updatedFrom: '1.0.0' });
    expect(installedVersion()).toBe('1.1.0');
    // Control: the card asking for more, clicked, is asked about.
    await sendInChat('share', { network: ['api.example.com'] }, '1.2.0');
    await installExtensionFromAttachment({ messageId: 'm-alice' }, dependencies);
    expect(requestInstallConsent).toHaveBeenCalledTimes(1);
  });

  it('摩擦单 F66 unasked: her own App from a folder is no card App — her card is held before a byte is downloaded', async () => {
    const { dir } = await sendInChat('share');
    service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, 'folder', { id: ALICE, name: 'Alice' });
    const { fetch } = await sendInChat('share', undefined, '1.1.0');
    await expect(installExtensionFromAttachment({ messageId: 'm-alice', unasked: true }, quiet)).resolves.toEqual({ installed: false, outcome: 'held' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces only an extension that itself came from chat — never a market or folder one, nor one from before origins were kept (E-05)', async () => {
    const { dir } = await sendInChat('share');
    const origins = path.join(state.userData, 'task-extensions', '.extension-origins.json');
    service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, 'market');
    const install = () => installExtensionFromAttachment({ messageId: 'm-alice' }, quiet);
    // Answered, not thrown: the card that was clicked says what is here (`refusedLine`); nothing is installed.
    const refused = (from: string | undefined) => ({
      installed: false,
      outcome: 'refused',
      id: 'share',
      installedVersion: '1.0.0',
      from,
      reason: expect.stringContaining('a package from chat cannot replace it'),
    });
    await expect(install()).resolves.toMatchObject(refused('market'));
    writeFileSync(origins, '{}');
    await expect(install()).resolves.toMatchObject(refused(undefined));
    expect(service.get('share').manifest.version).toBe('1.0.0');
    // One that came from chat may be replaced. With no publisher on record (installed before they were kept), it is
    // asked in full — not taken as an update of the same App (摩擦单 F66).
    writeFileSync(origins, JSON.stringify({ share: 'attachment' }));
    const requestInstallConsent = vi.fn().mockResolvedValue({ outcome: 'confirmed' });
    await expect(installExtensionFromAttachment({ messageId: 'm-alice' }, { ...quiet, requestInstallConsent }))
      .resolves.toMatchObject({ installed: true, updatedFrom: '1.0.0' });
    expect(requestInstallConsent.mock.calls[0]![0]).toMatchObject({ installed: undefined, attachment: { from: 'Alice', replaces: null } });
    // Named as the identity directory names the publisher, whatever the chat called the sender.
    expect(service.publishers()).toEqual({ share: { id: ALICE, name: 'Alice' } });

    service.uninstall('share');
    expect(service.origins()).toEqual({});
    expect(service.publishers()).toEqual({});
    writeFileSync(origins, JSON.stringify({ share: 'somewhere' }));
    expect(() => service.origins()).toThrow('.extension-origins.json is not a map of extension origins');
  });
});
