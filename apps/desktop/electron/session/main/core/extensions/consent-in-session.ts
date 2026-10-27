import { randomUUID } from 'node:crypto';
import { powerMonitor } from 'electron';
import type { SessionpageSessionRespondRequest } from '@gugu/session-core/session-record/contract';
import { log } from '@main/lib/logger';
import {
  APP_INSTALL_DECLINE_OPTION,
  APP_INSTALL_OPTION,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
  type AppInstallAsk,
  type ExtensionConsentRequester,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
} from '@shared/extensions/host-actions';
import { closeExtensionInstallConsent, requestExtensionInstallConsent } from './extension-bridge-relay';

/**
 * D-31 Someone is at this computer: input within this many seconds. Only then does an agent's install ask come in front of
 * them here (show + focus + steal), the way the owner verified it by eye (「会跳到眼前」 — someone in another app never saw a
 * sheet drawn behind it). With nobody here it is drawn in the window without raising it: L11 (复核 61) found the ask
 * stealing the focus of a computer nobody looked at while the person talked to the agent from their phone or another desktop,
 * and there the same ask is an approval in the agent's session already.
 */
export const IN_USE_IDLE_SECONDS = 60;

type SessionTimelineService = typeof import('@main/core/asks');

export interface ConsentInSessionDependencies {
  /** The session's `ask` and `respond` (asks/index.ts): the one place the ask is kept and every surface's answer settles it. */
  timeline: () => Promise<Pick<SessionTimelineService, 'ask' | 'respond'>>;
  /** Seconds since the last keyboard or mouse input on this computer. */
  idleSeconds: () => number;
  /** This computer's window; null on a Gugu server (no window — the session's approval is the only ask). */
  window: ((request: ExtensionInstallConsentRequest, options: { raise: boolean }) => Promise<ExtensionInstallConsentResult>) | null;
  closeWindow: (requestId: string) => Promise<void>;
}

/**
 * TEST-ONLY, env-gated (GUGU_SESSION_TEST_HOOKS=1): a rig sets `__guguConsentInUseForTest = { idleSeconds, raised: [] }` on the
 * main process over its inspector — the reading is taken from it, and a raise is recorded there instead of done: on a shared
 * machine (mac1) a raised window comes in front of whoever is using it (125 10-06). Unset in production.
 */
type InUseTestHook = { idleSeconds: number; raised: string[] };
function inUseTestHook(): InUseTestHook | null {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') return null;
  const hook = (globalThis as { __guguConsentInUseForTest?: Partial<InUseTestHook> }).__guguConsentInUseForTest;
  return hook && typeof hook.idleSeconds === 'number' && Array.isArray(hook.raised) ? (hook as InUseTestHook) : null;
}

const defaults: ConsentInSessionDependencies = {
  timeline: () => import('@main/core/asks'),
  idleSeconds: () => inUseTestHook()?.idleSeconds ?? powerMonitor.getSystemIdleTime(),
  // A Gugu server (GUGU_SERVER_MODE, embedded-boot's HEADLESS_SERVER) has no window to draw it in.
  window: process.env.GUGU_SERVER_MODE === '1'
    ? null
    : (request, { raise }) => {
        const hook = inUseTestHook();
        if (hook && raise && request.requestId) hook.raised.push(request.requestId);
        return requestExtensionInstallConsent(request, { raise: raise && !hook });
      },
  closeWindow: closeExtensionInstallConsent,
};

/**
 * D-31 (owner 10-06「怎么符合用户思维和操作路径怎么来」): an agent's App install is asked of the person as an approval in that
 * agent's session — kept on its timeline (L11 复核 67: a chat-UI session and a terminal one alike), wherever they follow it:
 * the phone's timeline, another desktop, the private chat's band — and the first answer settles it. This window draws the
 * same ask too, in front of the person only when they are at this computer (`IN_USE_IDLE_SECONDS`). Only an install
 * answered on a sheet that showed what it may do is taken (the manifest's fingerprint comes back with it): a surface that
 * draws it as a bare Install button is refused, and the ask stays. The person's clock (`INSTALL_CONSENT_HUMAN_WINDOW_MS`)
 * runs here — unanswered, the ask is withdrawn and the agent told it timed out; the agent's call going away (its turn
 * stopped) withdraws it too. No such session here: this window alone asks.
 */
export async function askInstallInSession(
  sessionId: string,
  request: ExtensionInstallConsentRequest,
  requester: ExtensionConsentRequester,
  dependencies: ConsentInSessionDependencies = defaults,
  callSignal?: AbortSignal
): Promise<ExtensionInstallConsentResult> {
  const requestId = randomUUID();
  const ask: ExtensionInstallConsentRequest = { ...request, requestId, requester };
  const raise = dependencies.idleSeconds() < IN_USE_IDLE_SECONDS;
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), INSTALL_CONSENT_HUMAN_WINDOW_MS);
  const gone = () => clock.abort();
  callSignal?.addEventListener('abort', gone, { once: true });
  const timeline = await dependencies.timeline();
  try {
    const answered = timeline.ask(
      sessionId,
      {
        itemId: requestId,
        kind: 'permission',
        // What a surface that does not know this kind shows; those that do draw the App, the agent and their own sheet.
        title: request.removeVariant ? `${requester.name}: remove fork ${request.removeVariant.name} from ${request.manifest.name}` : `${requester.name}: install ${request.manifest.name}`,
        options: [
          { optionId: APP_INSTALL_OPTION, name: request.removeVariant ? 'Remove fork' : 'Install', kind: 'allow_once' },
          { optionId: APP_INSTALL_DECLINE_OPTION, name: request.removeVariant ? 'Keep fork' : "Don't install", kind: 'reject_once' },
        ],
        origin: { source: 'app-install', payload: { request: ask } satisfies AppInstallAsk },
      },
      {
        signal: clock.signal,
        refuse: (answer) =>
          answer.optionId === APP_INSTALL_OPTION && answer.digest !== request.manifestDigest
            ? 'An App install is answered on the sheet that shows what it may do — this one did not show it (update Gugu here, or answer it on another of your screens)'
            : null,
      }
    );
    let inSession = true;
    void answered.then((result) => {
      if (result === 'unavailable') inSession = false;
    });
    // This window's sheet answers through the session too, so who answered is recorded the same way everywhere.
    const here = dependencies.window
      ? dependencies.window(ask, { raise })
      : Promise.reject(new Error('This Gugu server has no window: the install is asked in the agent’s session only'));
    if (!dependencies.window) here.catch(() => undefined);
    void here
      .then(async (answer) => {
        if (answer.outcome === 'timeout' || !inSession) return;
        const confirmed = answer.outcome === 'confirmed';
        const reply: SessionpageSessionRespondRequest = {
          conversationId: sessionId,
          itemId: requestId,
          kind: 'permission',
          optionId: confirmed ? APP_INSTALL_OPTION : APP_INSTALL_DECLINE_OPTION,
          // The sheet here showed this manifest.
          ...(confirmed ? { digest: request.manifestDigest, ...(answer.enableIn ? { enableIn: answer.enableIn } : {}) } : {}),
          by: 'desktop',
        };
        await timeline.respond(reply);
      })
      .catch((error: unknown) => log.warn('The install sheet in this window could not answer the session:', error));
    const result = await answered;
    if (result === 'unavailable') return await here;
    if (result === 'withdrawn' || result === 'timeout') return { outcome: callSignal?.aborted ? 'dismissed' : 'timeout' };
    return result.optionId === APP_INSTALL_OPTION
      ? { outcome: 'confirmed', ...(result.enableIn ? { enableIn: result.enableIn } : {}) }
      : { outcome: 'declined' };
  } finally {
    clearTimeout(timer);
    callSignal?.removeEventListener('abort', gone);
    // Answered on another surface (or ran out): the sheet here goes.
    void dependencies.closeWindow(requestId).catch(() => undefined);
  }
}
