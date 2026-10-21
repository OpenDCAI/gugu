import type { ExtensionOrigin } from './upgrade';

/**
 * Which App this is, as everything that names an App across devices and people names it (主人 10-01 14:3x): who
 * published it and its id — never its version. Where it is enabled in groups, which App a group file opens with, and
 * whether an update comes from the same publisher (摩擦单 F66) all compare this.
 *
 * - Preinstalled Apps and the official market's are gugu's (the market is published only by gugu).
 * - An App from a chat card or from a folder is the publisher recorded when it was installed: for a card the person
 *   behind the uploader (`publisherOf`), for a folder the account installing it (an agent installs with its owner's
 *   token). Recorded, not read off the signed-in account later: one device's Apps serve every account that signs in on
 *   it, and the App must stay the same App.
 * - An App with neither (installed from a folder before publishers were recorded for folders) has none: it works on
 *   this device, but nothing that names Apps across devices can name it until it is installed again.
 */
export interface AppIdentity {
  publisher: string;
  id: string;
}

export const GUGU_PUBLISHER = 'gugu';

export function appIdentityOf(app: {
  manifest: { id: string };
  origin: ExtensionOrigin | undefined;
  publisher: { id: string } | null | undefined;
}): AppIdentity | null {
  if (app.origin === 'preinstalled' || app.origin === 'market') return { publisher: GUGU_PUBLISHER, id: app.manifest.id };
  return app.publisher ? { publisher: app.publisher.id, id: app.manifest.id } : null;
}

/** `<publisher>/<id>`: one string for an identity, as the database's `last_writer` spells it before its `@<version>`. */
export function appKey(identity: AppIdentity): string {
  return `${identity.publisher}/${identity.id}`;
}

/** An account as the publisher rule needs it, from the identity directory (`identity.users`). */
export interface PublisherAccount {
  type: string | null;
  owner_user_id: string | null;
  display_name: string | null;
}

/** Who published an App: a person's id, and their name as the identity directory gives it (none for a folder's). */
export interface Publisher {
  id: string;
  name?: string;
}

/**
 * Who published a package an account uploaded: the person behind it — an agent's owner, anyone else themselves (an
 * agent with no owner is its own: there is no one behind it) — named as the identity directory names them. Each host
 * passes its own identity reader.
 */
export async function publisherOf(
  readAccount: (id: string) => Promise<PublisherAccount | null>,
  accountId: string
): Promise<Publisher> {
  const account = await readAccount(accountId);
  if (!account) throw new Error(`No account ${accountId}`);
  const personId = account.type === 'agent' && account.owner_user_id ? account.owner_user_id : accountId;
  const person = personId === accountId ? account : await readAccount(personId);
  if (!person) throw new Error(`No account ${personId}`);
  return { id: personId, ...(person.display_name ? { name: person.display_name } : {}) };
}
