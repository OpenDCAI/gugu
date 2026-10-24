import { guguLinkScheme, guguLink, type GuguLinkTarget } from '@gugu/core/shared/ui/guguLink';
import { openLinkWith, type LinkOpenOutcome } from '@shared/extensions/open-link';
import { sessionHostLocale } from '@main/core/host-locale';

export function currentLinkScheme(): string {
  return guguLinkScheme({ tier: process.env.GUGU_TIER, devLaunch: Boolean(process.defaultApp) });
}

/** Pure generation is shared by a page, phone and program; callers resolve their own default tab. */
export const linkTo = (target: Exclude<GuguLinkTarget, { kind: 'server-login' }>, external = false): string =>
  guguLink(target, external || (target.kind !== 'chat' && target.kind !== 'file') ? currentLinkScheme() : undefined);

/** The live path: main.ts hands every URL the OS gives it to this. */
export async function openLink(raw: string | GuguLinkTarget): Promise<LinkOpenOutcome> {
  const [{ extensionsService }, bridge, orchestration, { sessionHere }, { actInWindow, listedSessionProject }] = await Promise.all([
    import('./extensions-root'),
    import('./extension-bridge'),
    import('@main/core/sessions/session-orchestration'),
    import('./extension-show-session'),
    import('./extension-bridge-relay'),
  ]);
  return await openLinkWith(
    {
      installed: () => extensionsService().list().extensions,
      isEnabled: (id) => extensionsService().isEnabled(id),
      locale: sessionHostLocale,
      sessionProject: async (sessionId) => (await sessionHere(sessionId)) ?? listedSessionProject(sessionId),
      // App 面上那一格仍叫 sessionId(App 层那一刀改名);它的值就是那条会话的 id。
      reveal: ({ sessionId, ...target }) => orchestration.revealExtensionTabInSession({ ...target, sessionId: sessionId }),
      openApp: async (extensionId, tab, chatId) => {
        const opened = await actInWindow({ kind: 'openApp', extensionId, tab, ...(chatId ? { chatId } : {}) });
        if (!opened) throw new Error('The window did not return where the App opened');
        return opened;
      },
      resourceChat: async (chatId) => (await import('./app-files')).resourceChatOf(chatId),
      openResource: async (target) => {
        if (target.kind === 'session') {
          const { showSession } = await import('./extension-show-session');
          const [{ events }, { notificationFocusSessionChannel }] = await Promise.all([import('@main/lib/events'), import('@shared/events/appEvents')]);
          await showSession(target.sessionId, { projectHere: sessionHere, projectListed: listedSessionProject, bringUp: async (session) => { events.emit(notificationFocusSessionChannel, session); } });
        } else await actInWindow({ kind: 'openLinkTarget', target });
      },
      deliver: (id, event, opened) => {
        bridge.deliverToExtension(id, event, opened);
      },
    },
    raw,
  );
}
