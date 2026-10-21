import type { AppPlace } from '@shared/extensions/app-runtime-protocol';

/** Where a link opens the App: a session's tab or a chat's panel — a project's folder is no place a page is drawn. */
export type LinkPlace = Extract<AppPlace, { chat: string } | { session: string }>;
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import { extensionTabKind, type ExtensionManifest } from '@shared/extensions/manifest';
import { guguLinkScheme } from '@shared/extensions/link-scheme';

/**
 * Links into extensions: `<scheme>://ext/<extension>/<tab>/<path>?<query>`. Refs #6387.
 *
 * A link opens the App where it says (真源原则 13: never the session on screen): one of its tabs in a session it names,
 * the App in a chat's panel, or — naming neither — its own page; and hands the page the rest of the link. That is all it
 * can do: it names an installed extension and one of the tabs it declared, it carries data only that extension reads,
 * and nothing happens until a person clicks it. The extension builds its links with `linkTo` rather than spelling the
 * scheme, because the scheme depends on which build made the link. The place rides in the query, under keys of gugu's
 * own (`gugu.chat`, `gugu.session`), which an App's own query never uses.
 */

export const EXTENSION_LINK_HOST = 'ext';
/** Beyond this a link stops being a link and starts being a payload. */
export const MAX_EXTENSION_LINK_LENGTH = 2048;

export interface ParsedExtensionLink {
  extensionId: string;
  tab: string;
  path: string;
  query: Record<string, string>;
  /** Where it opens: a session, a chat — or null, the App's own page. */
  place: LinkPlace | null;
}

const PLACE_KEYS = { chat: 'gugu.chat', session: 'gugu.session' } as const;

export function currentLinkScheme(): string {
  return guguLinkScheme({ tier: process.env.GUGU_TIER, devLaunch: Boolean(process.defaultApp) });
}

export function buildExtensionLink(input: {
  scheme: string;
  manifest: ExtensionManifest;
  tab?: string;
  path: string;
  query: Record<string, unknown>;
  place?: LinkPlace | null;
}): string {
  const tab = input.tab ?? input.manifest.contributes.tabs[0]?.name;
  if (!tab || !input.manifest.contributes.tabs.some((entry) => entry.name === tab)) {
    throw new Error(`this App has no tab named: ${String(input.tab)}`);
  }
  const segments = input.path.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('path must not contain "." or ".." segments');
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('gugu.')) throw new Error(`query keys starting with "gugu." are gugu's own: ${key}`);
    if (typeof value === 'object') throw new Error(`query value for "${key}" must be a string, number or boolean`);
    search.append(key, String(value));
  }
  if (input.place) {
    const [kind, id] = 'chat' in input.place ? (['chat', input.place.chat] as const) : (['session', input.place.session] as const);
    search.append(PLACE_KEYS[kind], id);
  }
  const tail = segments.map(encodeURIComponent).join('/');
  const query = search.toString();
  const link = `${input.scheme}://${EXTENSION_LINK_HOST}/${input.manifest.id}/${tab}${tail ? `/${tail}` : ''}${query ? `?${query}` : ''}`;
  if (link.length > MAX_EXTENSION_LINK_LENGTH) {
    throw new Error(`link is longer than ${MAX_EXTENSION_LINK_LENGTH} characters — keep data in the App, put an id in the link`);
  }
  return link;
}

/** Null when the URL is not an extension link of this build — the caller ignores it. */
export function parseExtensionLink(raw: string, scheme: string): ParsedExtensionLink | null {
  if (raw.length > MAX_EXTENSION_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.hostname !== EXTENSION_LINK_HOST) return null;
  const [extensionId, tab, ...rest] = url.pathname.split('/').filter((segment) => segment !== '');
  if (!extensionId || !tab) return null;
  let path: string;
  try {
    path = rest.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
  const chat = url.searchParams.get(PLACE_KEYS.chat);
  const session = url.searchParams.get(PLACE_KEYS.session);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) if (!key.startsWith('gugu.')) query[key] = value;
  return { extensionId, tab, path, query, place: session ? { session } : chat ? { chat } : null };
}

export interface ExtensionLinkDeps {
  scheme: string;
  installed(): readonly { manifest: ExtensionManifest }[];
  isEnabled(extensionId: string): boolean;
  /** The interface language: a failure names the App as its manifest says it there. */
  locale(): string;
  /** The project of a session on this computer; null when it is not here. */
  sessionProject(sessionId: string): Promise<string | null>;
  reveal(target: { projectId: string; sessionId: string; tabKind: string }): Promise<void>;
  /** The App in a chat's panel, or on its own page (no chat). */
  openApp(extensionId: string, chatId: string | null): Promise<void>;
  deliver(extensionId: string, event: ExtensionHostEvent, opened: AppPlace | 'own'): void;
}

/**
 * What became of a link. A failure is returned, not thrown or logged: the person clicked
 * it and is waiting, so the host says why in their language (main.ts owns that copy).
 */
export type ExtensionLinkOutcome =
  | { kind: 'not-extension-link' }
  | { kind: 'opened'; extensionId: string; tab: string }
  | {
      kind: 'failed';
      reason: 'not-installed' | 'disabled' | 'no-such-tab' | 'no-session' | 'open-failed';
      /** The extension's name when installed, its id otherwise. */
      name: string;
      detail?: string;
    };

/** Open a link the OS handed us. URLs that are not extension links are left alone. */
export async function openExtensionLinkWith(deps: ExtensionLinkDeps, raw: string): Promise<ExtensionLinkOutcome> {
  const link = parseExtensionLink(raw, deps.scheme);
  if (!link) return { kind: 'not-extension-link' };
  const installed = deps.installed().find((entry) => entry.manifest.id === link.extensionId);
  if (!installed) return { kind: 'failed', reason: 'not-installed', name: link.extensionId };
  const { manifest } = installed;
  const name = localizedManifestText(manifest, deps.locale()).name;
  if (!deps.isEnabled(manifest.id)) return { kind: 'failed', reason: 'disabled', name };
  if (!manifest.contributes.tabs.some((tab) => tab.name === link.tab)) {
    return { kind: 'failed', reason: 'no-such-tab', name, detail: link.tab };
  }
  try {
    if (link.place && 'session' in link.place) {
      const projectId = await deps.sessionProject(link.place.session);
      if (!projectId) return { kind: 'failed', reason: 'no-session', name };
      await deps.reveal({ projectId, sessionId: link.place.session, tabKind: extensionTabKind(manifest.id, link.tab) });
    } else {
      await deps.openApp(manifest.id, link.place?.chat ?? null);
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
  return { kind: 'opened', extensionId: manifest.id, tab: link.tab };
}

/** `linkTo` for the bridge. */
export async function extensionLink(input: {
  extensionId: string;
  tab?: string;
  path: string;
  query: Record<string, unknown>;
  place: LinkPlace | null;
}): Promise<string> {
  const { extensionsService } = await import('./extensions-root');
  return buildExtensionLink({
    scheme: currentLinkScheme(),
    manifest: extensionsService().get(input.extensionId).manifest,
    ...(input.tab ? { tab: input.tab } : {}),
    path: input.path,
    query: input.query,
    place: input.place,
  });
}

/** The live path: main.ts hands every URL the OS gives it to this. */
export async function openExtensionLink(raw: string): Promise<ExtensionLinkOutcome> {
  const [{ extensionsService }, bridge, orchestration, { agentSessionContext }, { actInWindow }] = await Promise.all([
    import('./extensions-root'),
    import('./extension-bridge'),
    import('@main/core/sessions/session-orchestration'),
    import('./extension-agent-context'),
    import('./extension-bridge-relay'),
  ]);
  return await openExtensionLinkWith(
    {
      scheme: currentLinkScheme(),
      installed: () => extensionsService().list().extensions,
      isEnabled: (id) => extensionsService().isEnabled(id),
      locale: sessionHostLocale,
      sessionProject: async (sessionId) => (await agentSessionContext(sessionId))?.projectId ?? null,
      // App 面上那一格仍叫 sessionId(App 层那一刀改名);它的值就是那条会话的 id。
      reveal: ({ sessionId, ...target }) => orchestration.revealExtensionTabInSession({ ...target, sessionId: sessionId }),
      openApp: (extensionId, chatId) => actInWindow({ kind: 'openApp', extensionId, ...(chatId ? { chatId } : {}) }),
      deliver: (id, event, opened) => {
        bridge.deliverToExtension(id, event, opened);
      },
    },
    raw,
  );
}
