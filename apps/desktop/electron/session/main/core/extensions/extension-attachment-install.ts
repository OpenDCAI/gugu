import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { attachmentInstallPlan, couldUpdateUnasked, packageBytes, resolveAttachmentPackage, type AttachmentPackage, type InstalledApp } from '@shared/extensions/attachment-install';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { unpackExtensionArchive } from './extension-archive';
import { windowNoteOf } from './extension-bridge-relay';
import { installPrepared, notGivenNoteOf, type InstallDependencies } from './install-prepared';
import { extensionsService } from './extensions-root';
import { appIdentityOf, publisherOf } from '@shared/extensions/app-identity';
import type { HandedConsent } from '@shared/extensions/install-consent-flow';

/**
 * The package: the card's message (#7290), read as the signed-in person (`resolveAttachmentPackage`) — who published it is
 * the server's word on that message, and its bytes are signed by the server; a URL in the message is never trusted.
 */
export type AttachmentInstall = AttachmentPackage & {
  /** Nobody clicked (摩擦单 F66): installed only as an update that asks nothing, else left as it is — never a dialog. */
  unasked?: boolean;
  /** The chat the card is in: where its tools are given at first (D-30), when it is a place. */
  chatId?: string;
  /**
   * D-31 Asked on the person's side — another device installs it here (the card's 「装到哪台」, an agent's
   * `app_install { device }`): `return` hands back what it would ask (`outcome: 'ask'`, `asks` false when it would ask
   * nothing) instead of asking here; `given` installs what the person agreed to there, these bytes only (`digest`), given
   * what it gives there being the install's own rule (InstallGrant) — as every install takes it (install-prepared.ts).
   */
  consent?: HandedConsent;
};

export type AttachmentInstallDependencies = InstallDependencies;

/**
 * #6646 Installs an extension package sent in chat. Main downloads and fingerprints the bytes itself — what the
 * card showed is never trusted — unpacks them with the market's checks, validates, and installs through the same
 * consent and manifest-digest binding as any other install, recording the origin as `attachment`.
 */
export async function installExtensionFromAttachment(
  attachment: AttachmentInstall,
  dependencies: AttachmentInstallDependencies = {}
) {
  // What may be installed and what is asked is the shared answer (`attachment-install.ts`, the phone's too); main
  // downloads, unpacks, checks the files and installs.
  const files = await import('./app-files');
  const found = await resolveAttachmentPackage(attachment, files.packageReads);
  // The person behind the publisher the server vouches for (an agent's owner): who published these bytes (app-identity.ts).
  const publisher = await publisherOf(files.readAccount, found.publisher);
  const service = extensionsService();
  // An App installed here, as the shared answer reads it.
  const installedApp = ({ manifest }: { manifest: ExtensionManifest }): InstalledApp => ({
    manifest,
    origin: service.origins()[manifest.id],
    publisher: service.publishers()[manifest.id] ?? null,
    revokedPermissions: service.revokedPermissions(manifest.id),
  });
  // 摩擦单 F66: nobody clicked, and it could be no update of an App here — not downloaded.
  if (attachment.unasked && !couldUpdateUnasked(publisher.id, service.list().extensions.map(installedApp))) {
    await found.file.dispose();
    return { installed: false as const, outcome: 'held' as const };
  }
  // A deadline, because the consent window only starts after this.
  const bytes = await packageBytes(found.file);
  const { dir, sha256 } = await unpackExtensionArchive(service, bytes, path.join(app.getPath('userData'), 'extension-attachments'));
  try {
    const { manifest, manifestDigest } = service.inspectDirectory(dir);
    const installed = service.list().extensions.find((entry) => entry.manifest.id === manifest.id);
    const plan = attachmentInstallPlan({
      candidate: manifest,
      publisher: publisher.id,
      installed: installed && installedApp(installed),
      unasked: attachment.unasked === true,
    });
    const summary = { id: manifest.id, name: manifest.name, version: manifest.version, sha256 };
    // E-05: answered, not thrown — the card or the panel that was clicked says why to the person (`refusedLine`).
    if (plan.kind === 'refuse') return { installed: false, outcome: 'refused' as const, ...summary, reason: plan.reason, from: plan.from, installedVersion: plan.installedVersion };
    if (plan.kind === 'held') return { installed: false, outcome: 'held' as const, ...summary };
    // D-30: a first install of an App giving tools asks which agents get them, every agent here ticked at first; so does
    // a card's install in a chat the App is not given at yet (125 10-07), that chat ticked, even an update asking nothing
    // new. An update nobody clicked for asks nothing.
    const done = await installPrepared({
      dir,
      manifest,
      manifestDigest,
      origin: 'attachment',
      publisher,
      asks: plan.kind === 'ask',
      sheet: {
        // Another publisher's under the same id is asked in full (摩擦单 F66): the plan says it replaces nothing it knows.
        installed: plan.kind === 'ask' ? plan.installed : installed?.manifest,
        revokedPermissions: [...(plan.kind === 'ask' ? plan.revokedPermissions : service.revokedPermissions(manifest.id))],
        attachment: { from: publisher.name ?? '', ...(plan.kind === 'ask' && plan.replaces !== undefined ? { replaces: plan.replaces } : {}) },
      },
      places: { chatId: attachment.unasked ? undefined : attachment.chatId, identity: appIdentityOf({ manifest, origin: 'attachment', publisher }) },
    }, attachment.consent ?? { kind: 'here' }, dependencies);
    if (done.outcome === 'ask') return { installed: false, ...summary, ...done };
    if (done.outcome !== 'confirmed') return { installed: false, outcome: done.outcome, ...summary };
    const window = windowNoteOf(done.announced);
    return {
      installed: true,
      outcome: 'confirmed' as const,
      ...summary,
      ...(installed ? { updatedFrom: installed.manifest.version } : {}),
      ...(window ? { window: window.window, next: window.note } : {}),
      ...notGivenNoteOf(done),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
