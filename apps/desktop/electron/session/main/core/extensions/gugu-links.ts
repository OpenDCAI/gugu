import { guguLinkScheme, guguLink, type GuguLinkTarget, type OpenTarget } from '@gugu/core/shared/ui/guguLink';
import { openLinkWith, type LinkOpenOutcome } from '@shared/extensions/open-link';
import { sessionHostLocale } from '@main/core/host-locale';

export function currentLinkScheme(): string {
  return guguLinkScheme({ tier: process.env.GUGU_TIER, devLaunch: Boolean(process.defaultApp) });
}

/** Pure generation is shared by a page, phone and program; callers resolve their own default tab. */
export const linkTo = (target: Exclude<GuguLinkTarget, { kind: 'server-login' }>, external = false): string =>
  guguLink(target, external || (target.kind !== 'chat' && target.kind !== 'file') ? currentLinkScheme() : undefined);

/**
 * What only the app's main process knows when a session is opened (set at boot): the session an agent runs (its mapping on
 * this computer, else its machine's session list) and the platform recovery a session here gets before it is shown.
 */
export type SessionOpening = {
  agentSession(agentId: string, deviceId?: string): Promise<{ sessionId: string; deviceId?: string } | null>;
  ensureReady(sessionId: string): Promise<void>;
};
let opening: SessionOpening | null = null;
export function setSessionOpening(next: SessionOpening | null): void {
  opening = next;
}

/** The live path: main.ts hands every URL the OS gives it to this, and every click that opens a session comes here. */
export async function openLink(raw: string | OpenTarget): Promise<LinkOpenOutcome> {
  const [{ extensionsService }, bridge, { sessionHere }, { actInWindow, listedSessionProject }] = await Promise.all([
    import('./extensions-root'),
    import('./extension-bridge'),
    import('./extension-show-session'),
    import('./extension-bridge-relay'),
  ]);
  return await openLinkWith(
    {
      installed: () => extensionsService().list().extensions,
      isEnabled: (id) => extensionsService().isEnabled(id),
      locale: sessionHostLocale,
      // An archived session of this computer only when the opener named its project (任务历史 opens those).
      sessionProject: async (sessionId, hint) =>
        (await sessionHere(sessionId, { archived: Boolean(hint?.projectId && !hint.deviceId) })) ?? listedSessionProject(sessionId, hint),
      agentSession: async (agentId, deviceId) => (opening ? opening.agentSession(agentId, deviceId) : null),
      // App 面上那一格仍叫 sessionId(App 层那一刀改名);它的值就是那条会话的 id。
      reveal: async ({ sessionId, ...target }) =>
        (await import('@main/core/sessions/session-orchestration')).revealExtensionTabInSession({ ...target, sessionId: sessionId }),
      openApp: async (extensionId, tab, chatId) => {
        const opened = await actInWindow({ kind: 'openApp', extensionId, tab, ...(chatId ? { chatId } : {}) });
        if (!opened) throw new Error('The window did not return where the App opened');
        return opened;
      },
      resourceChat: async (chatId) => (await import('./app-files')).resourceChatOf(chatId),
      // The account shell resolves the assistant's task records first; desktop Markdown and OS links both come here.
      openResource: (target) => actInWindow({ kind: 'openLinkTarget', target }),
      bringUp: async (session) => {
        if (await sessionHere(session.sessionId)) await opening?.ensureReady(session.sessionId);
        await bridge.bringSessionUp(session);
      },
      deliver: (id, event, opened) => {
        bridge.deliverToExtension(id, event, opened);
      },
    },
    raw,
  );
}
