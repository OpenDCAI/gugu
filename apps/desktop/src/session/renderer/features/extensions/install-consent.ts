import {
  EXTENSION_CONSENT_ANSWER_EVENT,
  EXTENSION_CONSENT_EVENT,
  type EnablePlace,
  type ExtensionConsentAnswerDetail,
  type ExtensionConsentRequester,
  type ExtensionConsentEventDetail,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
  type InstallAlsoOnMachine,
} from '@shared/extensions/host-actions';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { getLocaleSnapshot } from '@/i18n';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { localizedManifestText } from '@shared/extensions/catalog';
import { computerNamed, consentPrompt, withMarketSource, type ConsentPrompt } from './extension-consent';

/**
 * An install's consent, as the person sees it — one wording and one sheet for every install that asks: a request from
 * the desktop's main process (host-action-handlers.ts) and the phone's own install of a chat package (L9) alike.
 */

/** What a consent is about. The desktop's request also names the unpacked folder; the words never depend on it. */
export type InstallConsentAsk = Omit<ExtensionInstallConsentRequest, 'sourceDir'>;

/**
 * The words: what it may do (`consentPrompt`), and where it came from — for a package from a chat who sent it (and whom it
 * would replace), for one from the market that it came from there.
 */
export function installConsentPrompt(request: InstallConsentAsk, manifest: ExtensionManifest): ConsentPrompt {
  const locale = getLocaleSnapshot().resolvedLocale;
  const asked = consentPrompt(request.installed, request.revokedPermissions, manifest, translateSessionMessage, locale, request.market?.releaseNotes, request.machine);
  if (request.removeVariant) {
    const values = { variant: request.removeVariant.name, name: localizedManifestText(manifest, locale).name, computer: computerNamed(translateSessionMessage, request.machine) };
    return { title: translateSessionMessage('extensions.removeVariantTitle', values),
      description: `${translateSessionMessage(request.removeVariant.active ? 'extensions.removeActiveVariantBody' : 'extensions.removeVariantBody', values)}${request.removeVariant.active ? `\n\n${asked.description}` : ''}`,
      confirmLabel: translateSessionMessage('extensions.removeVariantConfirm'), variant: 'default' };
  }
  const prompt = request.market ? withMarketSource(asked, translateSessionMessage) : asked;
  if (request.attachment) {
    // Whoever sent it may be gone (an agent whose profile was rebuilt): say so, not an empty name (摩擦单 F30).
    const from = request.attachment.from.trim() || translateSessionMessage('extensions.consentFromDeletedAgent');
    // 摩擦单 F66: another publisher's App under the id of one installed here — said first, by name.
    const replaces = request.attachment.replaces;
    // The one it would replace is on the computer it installs on (another one, named, when asked from here for it).
    const computer = computerNamed(translateSessionMessage, request.machine);
    const other =
      replaces === undefined
        ? ''
        : `${
            replaces?.trim()
              ? translateSessionMessage('extensions.consentOtherPublisher', { from, was: replaces.trim(), computer })
              : translateSessionMessage('extensions.consentOtherPublisherUnknown', { from, computer })
          }\n\n`;
    prompt.description = `${other}${translateSessionMessage('extensions.consentFromAttachment', { from })}\n\n${prompt.description}`;
  }
  // D-31 An agent asked for it: who, first — 「〈agent〉要装 X」, as a card says who sent it (F30).
  if (request.requester) {
    prompt.title = translateSessionMessage('extensions.installConfirmTitleBy', { agent: request.requester.name, name: localizedManifestText(manifest, locale).name });
  }
  return prompt;
}

/**
 * 摩擦单 F6: asked where the person is — the shell's consent sheet (ExtensionConsentSheet), over whatever view is on
 * screen — and answered within `timeoutMs` (the human window, INSTALL_CONSENT_HUMAN_WINDOW_MS), or it times out and the
 * sheet closes. Null when no shell drew it (the session page on its own): the caller then asks its own way, in the same window.
 */
export function askInShell(
  prompt: ConsentPrompt,
  requestId: string,
  timeoutMs: number,
  /** D-30: which agents get its tools — asked, these places listed (the ones ticked at first marked), when given. */
  places?: EnablePlace[],
  /** D-31: the agent that asked for it. */
  requester?: ExtensionConsentRequester,
  /** D-31: the computer it installs on, when that is not this one. */
  machine?: string,
  /** owner 10-16: the person's other computers it may also go on with the same yes. */
  alsoOn?: InstallAlsoOnMachine[]
): Promise<ExtensionInstallConsentResult> | null {
  const ask: Extract<ExtensionConsentEventDetail, { type: 'ask' }> = {
    type: 'ask',
    requestId,
    title: prompt.title,
    description: prompt.description,
    ...(prompt.details ? { details: prompt.details } : {}),
    ...(places ? { places } : {}),
    ...(requester ? { requester } : {}),
    ...(machine ? { machine } : {}),
    ...(alsoOn?.length ? { alsoOn } : {}),
    confirmLabel: prompt.confirmLabel,
    ...(prompt.cancelLabel ? { cancelLabel: prompt.cancelLabel } : {}),
    shown: false,
  };
  window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_EVENT, { detail: ask }));
  if (!ask.shown) return null;
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener(EXTENSION_CONSENT_ANSWER_EVENT, onAnswer);
      window.removeEventListener(EXTENSION_CONSENT_EVENT, onClosed);
      clearTimeout(timer);
    };
    const onAnswer = (event: Event) => {
      const answer = (event as CustomEvent<ExtensionConsentAnswerDetail>).detail;
      if (answer?.requestId !== requestId) return;
      done();
      resolve({ outcome: answer.outcome, ...(answer.enableIn ? { enableIn: answer.enableIn } : {}), ...(answer.alsoOn ? { alsoOn: answer.alsoOn } : {}) });
    };
    // D-31 Answered on another surface (closeInstallConsent): not answered here.
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<ExtensionConsentEventDetail>).detail;
      if (detail?.type !== 'close' || detail.requestId !== requestId) return;
      done();
      resolve({ outcome: 'timeout' });
    };
    const timer = setTimeout(() => {
      done();
      const close: ExtensionConsentEventDetail = { type: 'close', requestId };
      window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_EVENT, { detail: close }));
      resolve({ outcome: 'timeout' });
    }, timeoutMs);
    window.addEventListener(EXTENSION_CONSENT_ANSWER_EVENT, onAnswer);
    window.addEventListener(EXTENSION_CONSENT_EVENT, onClosed);
  });
}

/** D-31 Close this window's sheet for an ask answered elsewhere (main: `EXTENSION_INSTALL_CONSENT_CLOSE_METHOD`). */
export function closeInShell(requestId: string): void {
  const close: ExtensionConsentEventDetail = { type: 'close', requestId };
  window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_EVENT, { detail: close }));
}
