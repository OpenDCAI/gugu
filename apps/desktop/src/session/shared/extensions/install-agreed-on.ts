import { isInstallRefused, type AttachmentInstallRefused } from './attachment-install';
import type { HandedConsent } from './install-consent-flow';

/** What an install answers (`installFromMarket`, `installAttachment`, an agent's `app_install` there), as far as installing with a yes given elsewhere reads it. */
export type InstallAnswer<D extends Handed = Handed> = { success: boolean; error?: string; data?: D };
type Handed = { outcome?: string; installed?: boolean; ask?: { manifestDigest: string }; asks?: boolean; reason?: string };

/** The yes, decided between the two steps: the package agreed to (its digest, and where they ticked), or why not. */
export type Agreement = { digest: string } | { declined: string };

/**
 * owner 10-16「装的时候一次选好装到哪几台」: the package the person said yes to, on another of their computers, by that
 * computer's own install of it — `installFromMarket` for a market App, `installAttachment` for a card's package, an
 * agent's `app_install` there (`install` makes the one call with the consent it is given). That computer fetches and
 * checks it and hands back what it would ask; only the package agreed to — the same digest — goes in with that yes, and
 * one that fetched anything else is refused, never installed. `agree` is that yes, read off what that computer handed
 * back: the digest the sheet already agreed to, or (an agent's install, D-31) the person asked here. Answers the last
 * answer that computer gave, or the person's no.
 */
export async function installAgreedOn<D extends Handed>(
  install: (consent: HandedConsent) => Promise<InstallAnswer<D>>,
  agree: (handed: D) => Promise<Agreement>,
): Promise<D | { declined: string } | undefined> {
  const handed = answered(await install({ kind: 'return' }), 'that computer did not answer');
  if (!handed) throw new Error('that computer did not answer');
  if (handed.outcome !== 'ask') return handed;
  const agreement = await agree(handed);
  if ('declined' in agreement) return agreement;
  if (handed.ask?.manifestDigest !== agreement.digest) throw new Error('that computer fetched another package than the one agreed to');
  return answered(await install({ kind: 'given', ...agreement }), 'that computer did not install it');
}

/** E-05 refused an install (`AttachmentInstallRefused`): thrown with it, so whoever asked can say what is there. */
export class InstallRefusedError extends Error {
  constructor(readonly refusal: AttachmentInstallRefused) {
    super(refusal.reason);
  }
}

/**
 * An install's answer at either step — before the sheet (`return`) or with the yes (`given`): one that failed throws its
 * error, one that E-05 refused throws `InstallRefusedError` (what that computer has did not come from a chat — it may have
 * got the market's copy while the person read the sheet). The card's install and `installAgreedOn` both read answers here.
 */
export function answered<D extends { outcome?: string }>(answer: { success: boolean; error?: string; data?: D }, failed: string): D | undefined {
  if (!answer.success) throw new Error(answer.error ?? failed);
  if (answer.data && isInstallRefused(answer.data)) throw new InstallRefusedError(answer.data);
  return answer.data;
}
