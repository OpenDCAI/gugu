import {
  APP_INSTALL_DECLINE_OPTION,
  APP_INSTALL_OPTION,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
  type AppInstallAsk,
} from '@shared/extensions/host-actions';
import { safeParseExtensionManifest } from '@shared/extensions/manifest';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import { askInShell, installConsentPrompt } from './install-consent';

/**
 * D-31 An agent's App install, asked as an approval in its session, answered from this device — the session page here or on
 * another desktop, the phone's timeline, the private chat's band alike: 「不装」 answers at once; 「查看并安装」 opens this
 * device's own sheet (what it may do, 「详情」, 「给哪些 agent」) and its answer goes to the session with the places ticked.
 * Closing the sheet answers nothing: the approval stays where it was. `respond` is that surface's own way to the session's
 * `respond` (who answered is recorded there, the first answer wins).
 */
export async function answerAppInstall(input: {
  itemId: string;
  ask: AppInstallAsk;
  optionId: string;
  /** The computer the session runs on, when it is not this one (its agents are the ones 「给哪些 agent」 lists). */
  machine?: string;
  respond: (answer: { optionId: string; digest?: string }) => Promise<unknown>;
}): Promise<unknown> {
  if (input.optionId !== APP_INSTALL_OPTION) return input.respond({ optionId: APP_INSTALL_DECLINE_OPTION });
  const parsed = safeParseExtensionManifest(input.ask.request.manifest);
  if (!parsed.ok) throw new Error('This install asks about a manifest this build cannot read');
  // Installed on the computer the session runs on: when that is not this one, the sheet names it — its agents, its files.
  const machine = input.ask.request.machine ?? input.machine;
  const request = { ...input.ask.request, ...(machine ? { machine } : {}) };
  const sheet = askInShell(installConsentPrompt(request, parsed.manifest), input.itemId, INSTALL_CONSENT_HUMAN_WINDOW_MS, request.given, request.requester, machine);
  if (!sheet) throw new Error('No consent sheet in this window to ask the person with');
  const answer = await sheet;
  // The fingerprint of the manifest this sheet showed: an install is taken only with it (the host refuses one without).
  if (answer.outcome === 'confirmed') {
    return input.respond({ optionId: APP_INSTALL_OPTION, digest: request.manifestDigest });
  }
  if (answer.outcome === 'declined') return input.respond({ optionId: APP_INSTALL_DECLINE_OPTION });
  return undefined;
}

/**
 * Whether a host's ask can be out on this session: it waits on the person for an approval — the host's ask opens exactly that
 * wait (approval outranks every other wait kind, so the detail says so whenever one is out). Only then is the session's
 * timeline read for the band: reading it means folding the whole record on that machine, and a long session's record runs to
 * ~80 MB — 863 ms of work, the main process held up 285 ms and +128 MB of heap per open panel on mac1 (125 / L11 10-06).
 */
export function sessionWaitsOnApproval(session: { status: string | null; detail: string | null } | null | undefined): boolean {
  return session?.status === 'needs_user' && session.detail === 'approval';
}

/** A respond that lost to the host's clock: the ask was withdrawn before this answer — 「已经不等了」, not a failure. */
export function answeredTooLate(result: unknown): boolean {
  const value = (result as { ok?: boolean; value?: unknown } | null)?.ok === true ? (result as { value: unknown }).value : result;
  const { accepted, settlement } = (value ?? {}) as { accepted?: boolean; settlement?: { state?: string } };
  return accepted === false && settlement?.state === 'cancelled';
}

/** How a surface's approval band words an App install: who asks for what, and its two answers. */
export function appInstallWords(
  ask: AppInstallAsk,
  translate: (key: SessionMessageLookupKey, params?: Record<string, string>) => string
): { title: string; label: (optionId: string) => string | undefined } {
  const name = (ask.request.manifest as { name?: string }).name ?? '';
  return {
    title: ask.request.requester
      ? translate('extensions.installConfirmTitleBy', { agent: ask.request.requester.name, name })
      : translate('extensions.installConfirmTitle', { name }),
    label: (optionId) =>
      optionId === APP_INSTALL_OPTION
        ? translate('extensions.consentAsk')
        : optionId === APP_INSTALL_DECLINE_OPTION
          ? translate('extensions.consentDeclineAction')
          : undefined,
  };
}
