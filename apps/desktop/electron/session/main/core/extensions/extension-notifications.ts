import { fileRefOf, isWorkspace, workspaceSession, type AppFileRef, type AppPlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import { extensionTabKind, type ExtensionManifest } from '@shared/extensions/manifest';

/**
 * Extensions posting system banners (`notify`, capability `notifications`). Refs #6387.
 *
 * The banner is gugu's one reminder channel, so an extension borrows it rather than
 * getting a second one: it obeys the same two switches in Settings as the agents'
 * banners, and it always says which extension is talking — the title is shown under
 * the extension's installed name (in the interface language, as its `localized` says it), so no extension can post a banner that reads as
 * gugu's own.
 *
 * A click is the person asking to see it: gugu comes to the front, what the banner names is brought on screen (`open`,
 * 真源原则 13 — never where the page that posted it is): one of the App's tabs in a session, the App in a chat's panel,
 * a file where it lives — or, naming none, the App's own page, as a link naming none opens; and the extension is told
 * which banner was clicked.
 */

export interface ExtensionBanner {
  title: string;
  body: string;
  onClick: () => void;
  close: () => void;
}

export interface ExtensionNotifierDeps {
  manifestOf(extensionId: string): ExtensionManifest;
  /** The interface language: the App's name in the title is the one its manifest gives there. */
  locale(): string;
  /** Settings → Notifications, the same two switches agent banners obey. */
  notificationSettings(): Promise<{ enabled: boolean; sound: boolean }>;
  /**
   * `shown` settles when the system answers: resolved once the banner is actually on screen,
   * rejected with the reason when the system refuses it (e.g. gugu is not allowed to notify).
   */
  show(banner: { title: string; body: string; silent: boolean; onClick: () => void }): { close(): void; shown: Promise<void> };
  focusApp(): void;
  /** Brings what a click opens on screen: a tab (by kind) in a session, the App in a chat's panel or on its own page, a file. */
  open(
    target:
      | { session: string; tabKind: string }
      | { chat: string; extensionId: string }
      | { own: string }
      | { file: BannerFile },
  ): Promise<void>;
  /** The click, to the background page and to the App's pages where it opened (null: the background page alone). */
  deliver(extensionId: string, event: ExtensionHostEvent, opened: AppPlace | { session: string } | 'own' | null): void;
  onError(message: string, error: unknown): void;
  now(): number;
}

/**
 * Enough for a few distinct requests for attention in quick succession; a page that
 * posts in a loop is stopped and told why, instead of burying every other banner.
 */
/** A file a banner's click opens: a chat's, or a session's working copy's (a project's has no place a banner opens it). */
type BannerFile = AppFileRef & { id: string };

export const EXTENSION_NOTIFICATIONS_PER_MINUTE = 10;
const recent = new Map<string, number[]>();

/** One sliding window for each App or the agent device-action source. */
export function admitBanner(source: string, now: number): void {
  const window = (recent.get(source) ?? []).filter((at) => now - at < 60_000);
  if (window.length >= EXTENSION_NOTIFICATIONS_PER_MINUTE) {
    recent.set(source, window);
    throw new Error(
      `too many banners: at most ${EXTENSION_NOTIFICATIONS_PER_MINUTE} a minute — use a tag to update one instead of posting new ones`,
    );
  }
  window.push(now);
  recent.set(source, window);
}

/** The main-process device action and its user-pressed probe share the task preferences. */
export async function showDeviceNotification(title: string, body: string, options?: { probe: boolean }): Promise<{ shown: boolean }> {
  const [{ Notification }, { appSettingsService }, { log }] = await Promise.all([
    import('electron'), import('@main/core/settings/settings-service'), import('@main/lib/logger'),
  ]);
  const { enabled, sound } = await appSettingsService.get('notifications');
  if (!enabled || !Notification.isSupported()) return { shown: false };
  if (!options?.probe) admitBanner('device-action', Date.now());
  await showSystemBanner(Notification, log, 'device', { title, body, silent: !sound }).shown;
  return { shown: true };
}
const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_TAG = 64;
const MAX_DATA_BYTES = 8 * 1024;

/** What a click opens (`open`): a tab of the App in a session, the App in a chat's panel, or a file where it lives. */
type BannerOpen = { session: string; tab: string } | { chat: string } | { file: BannerFile };

function parseOpen(manifest: ExtensionManifest, raw: unknown): BannerOpen | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('open is { session, tab? }, { chat } or { file }');
  const open = raw as Record<string, unknown>;
  const places = (['session', 'chat', 'file'] as const).filter((key) => open[key] !== undefined && open[key] !== null);
  if (places.length !== 1) throw new Error('open names one place: { session, tab? }, { chat } or { file }');
  if (open.tab !== undefined && places[0] !== 'session') throw new Error('tab is for a session: a chat opens the App in its panel, a file opens where it lives');
  if (places[0] === 'file') {
    const file = fileRefOf(open.file);
    if (!('id' in file)) throw new Error('open.file is a file\'s entry or ctx.file');
    // A project's file opens beside a page (G1), and a banner is no page: it names the App's tab or the file's session.
    if (isWorkspace(file) && !workspaceSession(file)) throw new Error('open.file is a chat\'s or a session\'s file: a project\'s file opens beside a page');
    return { file };
  }
  const id = open[places[0]];
  if (typeof id !== 'string' || !id) throw new Error(`open.${places[0]} is an id, as getContext() gives it`);
  if (places[0] === 'chat') return { chat: id };
  const tab = open.tab === undefined ? manifest.contributes.tabs[0]?.name : typeof open.tab === 'string' ? open.tab : null;
  if (!tab || !manifest.contributes.tabs.some((entry) => entry.name === tab)) throw new Error(`this App has no tab named: ${String(open.tab)}`);
  return { session: id, tab };
}

export function createExtensionNotifier(deps: ExtensionNotifierDeps) {
  const byTag = new Map<string, { close(): void }>();

  function parse(manifest: ExtensionManifest, raw: Record<string, unknown>) {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) throw new Error('notify needs a title');
    if (title.length > MAX_TITLE) throw new Error(`title is longer than ${MAX_TITLE} characters`);
    const body = raw.body === undefined ? '' : typeof raw.body === 'string' ? raw.body.trim() : null;
    if (body === null) throw new Error('body must be a string');
    if (body.length > MAX_BODY) throw new Error(`body is longer than ${MAX_BODY} characters`);
    const tag = raw.tag === undefined ? undefined : typeof raw.tag === 'string' ? raw.tag : null;
    if (tag === null || (tag !== undefined && (tag.length === 0 || tag.length > MAX_TAG))) {
      throw new Error(`tag must be a non-empty string of at most ${MAX_TAG} characters`);
    }
    let data: unknown;
    if (raw.data !== undefined) {
      const json = JSON.stringify(raw.data);
      if (json === undefined) throw new Error('data must be JSON-serialisable');
      if (Buffer.byteLength(json) > MAX_DATA_BYTES) throw new Error(`data is larger than ${MAX_DATA_BYTES} bytes`);
      data = JSON.parse(json) as unknown;
    }
    // Named by the call, as every target is; naming none, the App's own page opens.
    return { title, body, tag, data, open: parseOpen(manifest, raw.open) };
  }

  function eventFor(parsed: { tag?: string | undefined; data?: unknown }): ExtensionHostEvent {
    return {
      type: 'notificationClicked',
      ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
      ...(parsed.data === undefined ? {} : { data: parsed.data }),
    };
  }

  async function notify(input: { extensionId: string; request: Record<string, unknown> }): Promise<{ shown: true }> {
    const manifest = deps.manifestOf(input.extensionId);
    const parsed = parse(manifest, input.request);
    // Said, not swallowed: an extension that thinks its banner went out will never
    // tell its user "turn notifications on to get these".
    const { enabled, sound } = await deps.notificationSettings();
    if (!enabled) {
      throw new Error('system notifications are turned off in gugu settings');
    }
    admitBanner(`app:${input.extensionId}`, deps.now());

    const tagKey = parsed.tag === undefined ? null : `${input.extensionId}\u0000${parsed.tag}`;
    if (tagKey) byTag.get(tagKey)?.close();

    const banner = deps.show({
      title: `${localizedManifestText(manifest, deps.locale()).name} · ${parsed.title}`,
      body: parsed.body,
      silent: !sound,
      onClick: () => {
        if (tagKey && byTag.get(tagKey) === banner) byTag.delete(tagKey);
        deps.focusApp();
        const event = eventFor(parsed);
        const open = parsed.open;
        void deps
          .open(
            !open
              ? { own: input.extensionId }
              : 'session' in open
                ? { session: open.session, tabKind: extensionTabKind(input.extensionId, open.tab) }
                : 'chat' in open
                  ? { chat: open.chat, extensionId: input.extensionId }
                  : open,
          )
          .catch((error: unknown) => deps.onError('could not open what a banner click names', error))
          // Delivered either way: the page may still act on the click even if it could not be brought up.
          .finally(() =>
            deps.deliver(
              input.extensionId,
              event,
              !open ? 'own' : 'file' in open ? null : 'chat' in open ? { chat: open.chat } : { session: open.session },
            ),
          );
      },
    });
    if (tagKey) byTag.set(tagKey, banner);
    // 等系统答复再回话:调完「显示」就说成功,系统随后拒绝时扩展还以为发出去了(#6387 实机:
    // 开发版没拿到通知权限,横幅被拒,notify 却回了 shown)。
    try {
      await banner.shown;
    } catch (error) {
      if (tagKey && byTag.get(tagKey) === banner) byTag.delete(tagKey);
      throw error;
    }
    return { shown: true };
  }

  return { notify };
}

/**
 * The system's refusal, in words the extension can pass on. macOS answers
 * UNErrorDomain 1 (UNErrorCodeNotificationsNotAllowed) when gugu has no permission to notify.
 */
export function refusalReason(systemError: string): string {
  if (/UNErrorDomain[^0-9]*1\b/.test(systemError)) {
    return 'the system does not allow gugu to show notifications (System Settings → Notifications)';
  }
  return `the system did not show the notification: ${systemError}`;
}

// Retain banners until close/click/refusal, including device banners without an App tag.
const live = new Set<import('electron').Notification>();

function showSystemBanner(
  Notification: typeof import('electron').Notification,
  log: Pick<typeof import('@main/lib/logger').log, 'info' | 'warn'>,
  source: 'extension' | 'device',
  { title, body, silent, onClick }: { title: string; body: string; silent: boolean; onClick?: () => void },
): ReturnType<ExtensionNotifierDeps['show']> {
  const banner = new Notification({ title, body, silent });
  live.add(banner);
  const release = () => live.delete(banner);
  banner.on('close', release);
  const shown = new Promise<void>((resolve, reject) => {
    banner.on('show', () => {
      log.info(`notification: ${source} banner shown`, { title });
      resolve();
    });
    banner.on('failed', (_event, error) => {
      release();
      log.warn(`notification: OS refused ${source} banner`, { error: String(error) });
      reject(new Error(refusalReason(String(error))));
    });
  });
  banner.on('click', () => {
    release();
    onClick?.();
  });
  banner.show();
  return { shown, close: () => { release(); banner.close(); } };
}

let notifier: ReturnType<typeof createExtensionNotifier> | null = null;

/** The live path: the bridge's `notify` verb lands here. */
export async function showExtensionNotification(input: { extensionId: string; request: Record<string, unknown> }): Promise<{ shown: true }> {
  if (!notifier) {
    const [electron, { extensionsService }, { appSettingsService }, { focusAppFromNotification }, bridge, orchestration, { log }, { agentSessionContext }, { actInWindow }, files] =
      await Promise.all([
        import('electron'),
        import('./extensions-root'),
        import('@main/core/settings/settings-service'),
        import('@main/core/agent-hooks/notification'),
        import('./extension-bridge'),
        import('@main/core/sessions/session-orchestration'),
        import('@main/lib/logger'),
        import('./extension-agent-context'),
        import('./extension-bridge-relay'),
        import('./app-files'),
      ]);
    const projectOf = async (sessionId: string) => {
      const projectId = (await agentSessionContext(sessionId))?.projectId;
      if (!projectId) throw new Error(`No session ${sessionId} on this computer`);
      return projectId;
    };
    notifier = createExtensionNotifier({
      manifestOf: (id) => extensionsService().get(id).manifest,
      locale: sessionHostLocale,
      notificationSettings: async () => {
        const { enabled, sound } = await appSettingsService.get('notifications');
        return { enabled: enabled && electron.Notification.isSupported(), sound };
      },
      show: (banner) => showSystemBanner(electron.Notification, log, 'extension', banner),
      focusApp: () => {
        focusAppFromNotification();
      },
      open: async (target) => {
        if ('session' in target) {
          await orchestration.revealExtensionTabInSession({ projectId: await projectOf(target.session), sessionId: target.session, tabKind: target.tabKind });
        } else if ('chat' in target) {
          await actInWindow({ kind: 'openApp', extensionId: target.extensionId, chatId: target.chat });
        } else if ('own' in target) {
          await actInWindow({ kind: 'openApp', extensionId: target.own });
        } else if (isWorkspace(target.file)) {
          const sessionId = workspaceSession(target.file)!;
          await orchestration.openSessionFileForApp({ projectId: await projectOf(sessionId), sessionId, path: target.file.id, ask: false });
        } else {
          await actInWindow({ kind: 'openChatFile', chatId: target.file.chat ?? (await files.chatOfItem(target.file.id)), itemId: target.file.id });
        }
      },
      deliver: (id, event, opened) => {
        bridge.deliverToExtension(id, event, opened);
      },
      onError: (message, error) => log.warn(`extension banner: ${message}`, { error: String(error) }),
      now: () => Date.now(),
    });
  }
  return await notifier.notify(input);
}
