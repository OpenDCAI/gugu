import { parseGuguLink, type GuguLinkTarget, type LinkPlace } from '@gugu/core/shared/ui/guguLink';
import type { ExtensionHostEvent } from './bridge-protocol';
import { localizedManifestText } from './catalog';
import { extensionTabKind, type ExtensionManifest } from './manifest';

export interface LinkOpenDeps {
  supabaseUrl?: string;
  installed(): readonly { manifest: ExtensionManifest }[];
  isEnabled(extensionId: string): boolean;
  /** The interface language: a failure names the App as its manifest says it there. */
  locale(): string;
  /** The project of a session on this computer; null when it is not here. */
  sessionProject(sessionId: string): Promise<string | null>;
  reveal(target: { projectId: string; sessionId: string; tabKind: string }): Promise<void>;
  /** The App in a chat's panel, or on its own page (no chat). */
  openApp(extensionId: string, tab: string, chatId: string | null): Promise<LinkPlace | 'own'>;
  resourceChat(chatId: string): Promise<string>;
  openResource(target: Exclude<GuguLinkTarget, { kind: 'app' }>): Promise<void>;
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
export async function openLinkWith(deps: LinkOpenDeps, raw: string | GuguLinkTarget): Promise<LinkOpenOutcome> {
  const link = typeof raw === 'string' ? parseGuguLink(raw, { supabaseUrl: deps.supabaseUrl }) : raw;
  if (!link) return { kind: 'not-gugu-link' };
  if (link.kind !== 'app') {
    try {
      await deps.openResource(link);
      return { kind: 'opened', target: link };
    } catch (error) {
      return { kind: 'failed', reason: 'open-failed', name: link.kind, detail: error instanceof Error ? error.message : String(error) };
    }
  }
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

