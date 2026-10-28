import { EXTENSION_ARCHIVE_MIME, resolveAttachmentMimeType } from '@gugu/core/shared/imageMime.mjs';
import { fileBlob, type FileHandle } from '@gugu/core/shared/fileResolver';
import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation';
import { parseAttachmentContent, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels';
import { appIdentityOf, type Publisher } from './app-identity';
import { declaredPermissions } from './catalog';
import { compareExtensionVersions, type ExtensionCapability, type ExtensionManifest } from './manifest';
import { replacesWithoutAsking, type ExtensionOrigin } from './upgrade';

/**
 * An App package sent in a chat, installed on this device: whether it may, and what the person is asked first. One
 * answer for the desktop (main) and the phone (the outer gugu page, L9) — each of them only downloads, unpacks, checks
 * the files and stores; what is allowed and what is asked is decided here, so the two can never drift apart.
 */

/**
 * A package sent in a chat, as an install names it: the card's message (#7290). The host reads that message as the
 * signed-in person and takes the package from it (`resolveAttachmentPackage`) — old cards and new ones alike.
 */
export interface AttachmentPackage {
  messageId: string;
}

/** The columns of the card's message an install reads (`chat.messages_view`, as the signed-in person). */
export const PACKAGE_MESSAGE_SELECT = 'id,sender_user_id,content,file_item_id,file_version,file_blob_id';
export interface PackageMessageRow {
  id: string;
  /** null once the sender deleted their account (gugu-supabase 20260721100000). */
  sender_user_id: string | null;
  content: string;
  file_item_id: string | null;
  file_version: number | null;
  file_blob_id: string | null;
}

/**
 * Where a card's package is and who published it (#7290) — one rule for every card: its publisher is the one who sent you
 * the card, the message's sender (owner 10-17; a forward is its forwarder's, never the source's). Its bytes are signed by
 * attachments/urls for that item, or for that message (a whisper's, an old card's — by its storage columns, never the URL
 * its text carries). Never the manifest's word.
 */
export function messagePackageSource(row: PackageMessageRow): { publisher: string; source: AttachmentSource } | { problem: string } {
  const parsed = parseAttachmentContent(row.content, row);
  if (!parsed || resolveAttachmentMimeType(parsed.fileName, parsed.mimeType) !== EXTENSION_ARCHIVE_MIME) {
    return { problem: `message ${row.id} has no App package (.guguext) attached` };
  }
  if (parsed.source.kind === 'gone') return { problem: `the App package of message ${row.id} was deleted from the group folder` };
  if (!row.sender_user_id) return { problem: `the one who sent message ${row.id} has deleted their account` };
  const source: AttachmentSource = parsed.source.kind === 'item' ? parsed.source : { kind: 'message', messageId: row.id };
  return { publisher: row.sender_user_id.toLowerCase(), source };
}

/** How a host reads a card's message and signs a link to its bytes — its own clients; what is decided is decided here. */
export interface PackageReads {
  /** The card's message as the signed-in person reads it (`PACKAGE_MESSAGE_SELECT` from `chat.messages_view`); null: none they can read. */
  message(messageId: string): Promise<PackageMessageRow | null>;
  /** A lazy verified-original capability; null: no longer there. Resolving never signs or reads. */
  open(source: AttachmentSource): Promise<FileHandle | null>;
}

/** Both hosts preserve the package's bounded download deadline and cancel the underlying verified acquisition. */
export const packageBytes = (file: FileHandle) => withBoundedOperation(15_000, () => new Error('App package download timed out'), async signal => {
  const cancel = () => { void file.dispose(); };
  signal.addEventListener('abort', cancel, { once: true });
  try { return new Uint8Array(await (await fileBlob(file)).arrayBuffer()); }
  finally { signal.removeEventListener('abort', cancel); }
});

/** Who published a card's package and where its bytes are (#7290): read from its message, as the signed-in person. */
export async function resolveAttachmentPackage(pkg: AttachmentPackage, reads: PackageReads): Promise<{ publisher: string; file: FileHandle }> {
  const row = await reads.message(pkg.messageId);
  if (!row) throw new Error(`There is no message ${pkg.messageId} you can read`);
  const found = messagePackageSource(row);
  if ('problem' in found) throw new Error(found.problem);
  const file = await reads.open(found.source);
  if (!file) throw new Error(`The App package of message ${pkg.messageId} is no longer there`);
  return { publisher: found.publisher, file };
}

/** The App of the package's id installed here, as far as the decision needs it. */
export interface InstalledApp {
  manifest: ExtensionManifest;
  origin: ExtensionOrigin | undefined;
  /** Who published it, as recorded when it was installed (摩擦单 F66); null for one installed before publishers were kept. */
  publisher: Publisher | null;
  revokedPermissions: readonly string[];
}

export type AttachmentInstallPlan =
  /**
   * E-05: what is installed under this id did not come from a chat, so this package may not replace it. `reason` is the
   * install's own word (agents and logs read it); `from` and `installedVersion` are what the card and the panel tell the
   * person, both platforms the same.
   */
  | { kind: 'refuse'; reason: string; from: ExtensionOrigin | undefined; installedVersion: string }
  /** Nothing to ask: the person's click on the card is the consent. */
  | { kind: 'install' }
  /**
   * Asked first, in the consent sheet both platforms draw: about everything when `installed` is absent (a first install,
   * or another publisher's App — `replaces` names whom it would replace), else only about what it newly asks for.
   */
  | { kind: 'ask'; installed: ExtensionManifest | undefined; revokedPermissions: readonly string[]; replaces?: string | null }
  /** Nobody clicked (`unasked`) and it is not an update that may go in alone: left for the person, nothing asked. */
  | { kind: 'held' };

/** An install from a card answered with E-05's refusal (desktop main and the phone alike): see the `refuse` plan. */
export interface AttachmentInstallRefused {
  installed: false;
  outcome: 'refused';
  id: string;
  name: string;
  version: string;
  reason: string;
  from: ExtensionOrigin | undefined;
  installedVersion: string;
}

export function isInstallRefused(answer: { outcome?: string }): answer is AttachmentInstallRefused {
  return answer.outcome === 'refused';
}

interface AttachmentInstallRequest {
  candidate: ExtensionManifest;
  /** Who published these bytes: the person behind the publisher the server wrote on the card's message (app-identity.ts `publisherOf`). */
  publisher: string;
  installed: InstalledApp | undefined;
  /** Nobody clicked: the host found the card by itself (摩擦单 F66, `updateUnasked`). */
  unasked?: boolean;
}

/**
 * A manifest as one host can grant it (125 10-06): its capabilities cut to what that host can do — what its consent asks
 * about, as its pages are given only that (capabilities = consented ∩ what the host can). A host that can grant none of
 * them asks nothing, as for an App that asks for nothing. Network hosts stay: every host reaches the network.
 */
export function grantableBy(manifest: ExtensionManifest, host: readonly ExtensionCapability[]): ExtensionManifest {
  const declared = manifest.permissions?.capabilities;
  if (!declared) return manifest;
  return { ...manifest, permissions: { ...manifest.permissions, capabilities: declared.filter((capability) => host.includes(capability)) } };
}

/** 摩擦单 F66, asked before anything is downloaded: could an unasked package of `publisher` update a card App here at all. */
export function couldUpdateUnasked(publisher: string, installed: readonly InstalledApp[]): boolean {
  return installed.some((app) => app.origin === 'attachment' && appIdentityOf(app)?.publisher === publisher);
}

/**
 * E-05: a package from chat may only replace an App that itself came from chat — never a market, folder or preinstalled
 * one, nor one whose origin was never kept. The install's own gate (`clickedPlan`), and what a card or a group's panel
 * offers (`cardOffer`, `groupUpdateFor`), so neither promises an update the install would refuse.
 */
export function replaceableFromChat(origin: ExtensionOrigin | undefined): boolean {
  return origin === 'attachment';
}

export function attachmentInstallPlan(args: AttachmentInstallRequest): AttachmentInstallPlan {
  const plan = clickedPlan(args);
  // 摩擦单 F66 (主人 10-01): what nobody clicked for goes in only as an update — of the App of this identity installed
  // here, to a later version, asking nothing new. Anything else waits for the person's click on the card.
  const { candidate, installed } = args;
  const update = plan.kind === 'install' && installed !== undefined && compareExtensionVersions(candidate.version, installed.manifest.version) > 0;
  return !args.unasked || update ? plan : { kind: 'held' };
}

function clickedPlan({ candidate, publisher, installed }: AttachmentInstallRequest): AttachmentInstallPlan {
  if (installed && !replaceableFromChat(installed.origin)) {
    return {
      kind: 'refuse',
      reason: `"${candidate.id}" is already installed from somewhere other than a chat attachment; a package from chat cannot replace it`,
      from: installed.origin,
      installedVersion: installed.manifest.version,
    };
  }
  const installedPublisher = installed ? appIdentityOf(installed)?.publisher ?? null : null;
  // The one rule every install follows (upgrade.ts): its own publisher's update asking for nothing more than the
  // installed version had just goes in — the click on the card is the consent (摩擦单 F21: a prompt there is friction).
  if (
    installed &&
    replacesWithoutAsking({
      installed: installed.manifest,
      installedOrigin: installed.origin,
      installedPublisher,
      publisher,
      revokedPermissions: installed.revokedPermissions,
      candidate,
      origin: 'attachment',
    })
  ) {
    return { kind: 'install' };
  }
  // A first install: the click is the consent for what asks nothing (it can come from anyone in a chat, so what does
  // ask waits for the person).
  if (!installed && declaredPermissions(candidate).length === 0) return { kind: 'install' };
  // From someone else than the one installed (摩擦单 F66, 统筹 06:16): not an update of what the person trusted but
  // another publisher's App under the same id — asked in full, saying who, however little it asks for (anyone could
  // otherwise replace a trusted App by sending a higher version). Its own publisher's asking for more: only that.
  const otherPublisher = installed !== undefined && installedPublisher !== publisher;
  return {
    kind: 'ask',
    // Another publisher's: everything it declares is shown, as for a first install.
    installed: otherPublisher ? undefined : installed?.manifest,
    revokedPermissions: installed?.revokedPermissions ?? [],
    ...(otherPublisher ? { replaces: installed?.publisher?.name ?? null } : {}),
  };
}
