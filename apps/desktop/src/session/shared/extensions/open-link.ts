import { parseGuguLink, type GuguLinkTarget, type LinkPlace, type OpenTarget } from '@gugu/core/shared/ui/guguLink';
import type { ExtensionHostEvent } from './bridge-protocol';
import { localizedManifestText } from './catalog';
import { extensionTabKind, type ExtensionManifest } from './manifest';

export interface LinkOpenDeps {
  supabaseUrl?: string;
  installed(): readonly { manifest: ExtensionManifest }[];
  isEnabled(extensionId: string): boolean;
  /** The interface language: a failure names the App as its manifest says it there. */
  locale(): string;
  /**
   * The project the task list has a session under (this computer's, or another machine's it lists); null when none.
   * `hint` is what the opener knew: with its machine, a session the list does not draw is reached through that machine.
   */
  sessionProject(sessionId: string, hint?: { deviceId?: string; projectId?: string }): Promise<string | null>;
  /** An agent's session: this computer's mapping first, else the session list of the machine it runs on; null when none. */
  agentSession(agentId: string, deviceId?: string): Promise<{ sessionId: string; deviceId?: string } | null>;
  reveal(target: { projectId: string; sessionId: string; tabKind: string }): Promise<void>;
  /** The App in a chat's panel, or on its own page (no chat). */
  openApp(extensionId: string, tab: string, chatId: string | null): Promise<LinkPlace | 'own'>;
  resourceChat(chatId: string): Promise<string>;
  /** The window opens what it can; for a session only the personal assistant's own task, nothing (undefined) otherwise. */
  openResource(target: Exclude<GuguLinkTarget, { kind: 'app' }>): Promise<LinkPlace | 'own' | void>;
  /** A session brought up the way a click on its row in the task list brings it (found by `sessionProject`); `beside` keeps the screen view's layout. */
  bringUp(session: { projectId: string; sessionId: string; beside?: true }): Promise<void>;
  deliver(extensionId: string, event: ExtensionHostEvent, opened: LinkPlace | 'own'): void;
}

/**
 * What became of a link. A failure is returned, not thrown or logged: the person clicked
 * it and is waiting, so the host says why in their language (main.ts owns that copy).
 */
export type LinkOpenOutcome =
  | { kind: 'not-gugu-link' }
  | { kind: 'opened'; target: GuguLinkTarget }
  | {
      kind: 'failed';
      reason: 'not-installed' | 'disabled' | 'no-such-tab' | 'no-session' | 'open-failed';
      /** The extension's name when installed, its id otherwise. */
      name: string;
      detail?: string;
    };

/** Open one resolved resource, whether a click inside gugu or a URL handed to us by the OS. */
export async function openLinkWith(deps: LinkOpenDeps, raw: string | OpenTarget): Promise<LinkOpenOutcome> {
  const named = typeof raw === 'string' ? parseGuguLink(raw, { supabaseUrl: deps.supabaseUrl }) : raw;
  if (!named) return { kind: 'not-gugu-link' };
  if (named.kind !== 'app') {
    try {
      // An agent named instead of its session: found here, once, for every opener (its machine's mapping or session list).
      let link: Exclude<GuguLinkTarget, { kind: 'app' }>;
      if (named.kind === 'session' && 'agentId' in named) {
        const found = await deps.agentSession(named.agentId, named.deviceId);
        if (!found) return { kind: 'failed', reason: 'no-session', name: named.kind };
        link = { kind: 'session', sessionId: found.sessionId, ...(found.deviceId ? { deviceId: found.deviceId } : {}) };
      } else link = named;
      // One way for every host: the window first (the assistant's task opens in its chat), then the host's own task list.
      if (!(await deps.openResource(link)) && link.kind === 'session') {
        const projectId = await deps.sessionProject(link.sessionId, { deviceId: link.deviceId, projectId: link.projectId });
        if (!projectId) return { kind: 'failed', reason: 'no-session', name: link.kind };
        await deps.bringUp({ projectId, sessionId: link.sessionId, ...(link.beside ? { beside: true } : {}) });
      }
      return { kind: 'opened', target: link };
    } catch (error) {
      return { kind: 'failed', reason: 'open-failed', name: named.kind, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const link = named;
  const installed = deps.installed().find((entry) => entry.manifest.id === link.extensionId);
  if (!installed) return { kind: 'failed', reason: 'not-installed', name: link.extensionId };
  const { manifest } = installed;
  const name = localizedManifestText(manifest, deps.locale()).name;
  if (!deps.isEnabled(manifest.id)) return { kind: 'failed', reason: 'disabled', name };
  if (!manifest.contributes.tabs.some((tab) => tab.name === link.tab)) {
    return { kind: 'failed', reason: 'no-such-tab', name, detail: link.tab };
  }
  try {
    if (link.place && 'chat' in link.place) {
      link.place = { chat: await deps.resourceChat(link.place.chat) };
    }
    if (link.place && 'session' in link.place) {
      const projectId = await deps.sessionProject(link.place.session);
      if (!projectId) return { kind: 'failed', reason: 'no-session', name };
      await deps.reveal({ projectId, sessionId: link.place.session, tabKind: extensionTabKind(manifest.id, link.tab) });
    } else {
      const opened = await deps.openApp(manifest.id, link.tab, link.place?.chat ?? null);
      link.place = opened === 'own' ? null : opened;
    }
  } catch (error) {
    return {
      kind: 'failed',
      reason: 'open-failed',
      name,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  deps.deliver(manifest.id, { type: 'link', tab: link.tab, path: link.path, query: link.query, file: null }, link.place ?? 'own');
  return { kind: 'opened', target: link };
}

