import type { ChatFileRef } from '@shared/extensions/app-files-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import {
  clearExtensionSessionData,
  configureExtensionSession,
  reloadExtensionSurfaces,
} from '@main/core/extensions/extension-session';
import {
  chatMembersChanged,
  bindExtensionSurface,
  retargetExtensionSurface,
  notifyGroupWorkspaceChanged,
  notifyInstalledAppsChanged,
  invokeExtensionCommand,
  deliverToOpeningPage,
  deliverToSessionFilePage,
  setExtensionAppView,
  unbindExtensionSurfaces,
  updateExtensionSurfaceLayout,
} from '@main/core/extensions/extension-bridge';
import {
  extensionDataRoot,
  extensionsService,
} from '@main/core/extensions/extensions-root';
import type { ExtensionDisclosure } from '@main/core/extensions/extensions-service';
import { placeFor, placeLink } from '@shared/extensions/file-openers';
import { removeUninstalledLeftovers } from '@main/core/extensions/extension-session-snapshot';
import { extensionPrograms, extensionProgramStatus, retireExtensionPrograms, toolVisibleTo } from '@main/core/extensions/extension-programs';
import { firstSentence } from '../../../../mcp/first-sentence';
import {
  extensionOpened,
  forgetQuit,
  quitExtension,
  quitExtensions,
  syncExtensionBackgrounds,
} from '@main/core/extensions/extension-background';
import { extensionVariants, prepareVariant, switchExtensionVariant } from './extension-variants';
import { prepareForkVariant } from './app-forks';
import { installPlan } from '@main/core/extensions/install-plan';
import type { HandedConsent } from '@shared/extensions/install-consent-flow';
import { installPrepared } from '@main/core/extensions/install-prepared';
import { EXTENSION_ARCHIVE_MIME, packInstalledExtension } from '@main/core/extensions/extension-archive';
import { closeCheckPages } from '@main/core/extensions/extension-check';
import { installExtensionFromAttachment, type AttachmentInstall } from '@main/core/extensions/extension-attachment-install';
import { installExtensionFromMarket, type MarketInstall } from '@main/core/extensions/extension-market-install';
import { autoUpdateApps } from '@main/core/extensions/auto-update-apps';
import { appService } from '@main/core/app/service';
import { cloudExtensionMarket } from '@main/core/extensions/market-catalog-root';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { renderExtensionIcon } from '@main/core/extensions/extension-icon';
import { APP_ICON_PIXELS } from '@shared/extensions/app-icon';
import { extensionPartition, extensionResourceUrl } from '@shared/extensions/partition';
import {
  extensionTabKind,
  parseExtensionTabKind,
  type ExtensionManifest,
} from '@shared/extensions/manifest';
import type { CloudMarketEntry, MarketListItem } from '@shared/extensions/market';
import {
  extensionsInventoryChangedChannel,
  extensionsQuitChangedChannel,
} from '@shared/extensions/marketEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';

/**
 * Which page a given tab draws.
 *
 * A tab may bring its own `entry`; without one it draws the manifest's. ❌ 不是
 * 「找不到就回落到 manifest.entry」—— 那样一个拼错的 tabKind 会安静地画出别的 tab 的
 * 页面,看上去完全正常。认不出来就报错停:调用方是宿主自己,拿到的是自己注册过的 kind。
 */
function entryForTab(manifest: ExtensionManifest, tabKind: string | undefined): string {
  if (!tabKind) {
    if (!manifest.entry) throw new Error('This App uses the host settings page');
    return manifest.entry;
  }
  const parsed = parseExtensionTabKind(tabKind);
  const contribution =
    parsed?.extensionId === manifest.id
      ? manifest.contributes.tabs.find((tab) => tab.name === parsed.tabName)
      : undefined;
  if (!contribution) {
    throw new Error(`"${tabKind}" is not a tab of extension "${manifest.id}"`);
  }
  const entry = contribution.entry ?? manifest.entry;
  if (contribution.hostPage || !entry) throw new Error('This App tab uses the host settings page');
  return entry;
}

/** For each extension that gives agents tools: whether new sessions list them up front. */
function disclosureOf(manifests: readonly ExtensionManifest[]) {
  return Object.fromEntries(
    manifests
      .filter((manifest) => (manifest.contributes.mcpServers ?? []).length > 0)
      .map((manifest) => [manifest.id, extensionsService().disclosure(manifest.id)])
  );
}

/** The installed copy of an extension when what is installed is exactly this version; null otherwise. */
function installedAtVersion(extensionId: string, version: string) {
  try {
    const installed = extensionsService().get(extensionId);
    return installed.manifest.version === version ? installed : null;
  } catch {
    // not installed here (or unreadable): the copy to read is the market's
    return null;
  }
}

/** The bundle's README.md (the file the market keeps from a package, any letter case); null when it has none. */
function readBundleReadme(rootDir: string): string | null {
  const name = fs.readdirSync(rootDir).find((file) => file.toLowerCase() === 'readme.md');
  return name ? fs.readFileSync(path.join(rootDir, name), 'utf8') : null;
}

/**
 * Extension inventory over IPC. `inspect` exists so the install flow can show
 * what an extension declares *before* the user consents — installing is never
 * the first thing that happens to a bundle the user has not agreed to. Refs #2374.
 */
export const extensionsController = createRPCController({
  variants: async (id: string) => {
    try { return { success: true as const, data: await extensionVariants(id) }; }
    catch (error) { return { success: false as const, error: error instanceof Error ? error.message : String(error) }; }
  },
  switchVariant: async (id: string, name: string, consent?: HandedConsent) => {
    try { return { success: true as const, data: await switchExtensionVariant(id, name, consent) }; }
    catch (error) { return { success: false as const, error: error instanceof Error ? error.message : String(error) }; }
  },
  openLink: async (args: { target: import('@gugu/core/shared/ui/guguLink').GuguLinkTarget }) =>
    (await import('./gugu-links')).openLink(args.target),
  list: async () => {
    try {
      const { extensions, invalid } = extensionsService().list();
      // Icons are re-encoded here rather than fetched by the renderer: the
      // privileged renderer has no gugu-ext:// handler and must not be pointed
      // at extension-supplied bytes. A tab whose icon fails to decode simply
      // has none — one bad file must not cost the other extensions their listing.
      const icons: Record<string, string> = {};
      // The App's own icon, for the far-left rail (its dock): drawn there at the rail's size.
      const appIcons: Record<string, string> = {};
      for (const entry of extensions) {
        if (entry.manifest.icon) {
          const rendered = renderExtensionIcon(entry.rootDir, entry.manifest.icon, APP_ICON_PIXELS);
          if ('dataUrl' in rendered) appIcons[entry.manifest.id] = rendered.dataUrl;
          else log.warn(`Extension ${entry.manifest.id}: ${rendered.reason}`);
        }
        for (const tab of entry.manifest.contributes.tabs) {
          // A tab without an icon of its own is drawn with its App's (owner 10-17: 日历、雷达 in the 「+」 menu).
          const icon = tab.icon ?? entry.manifest.icon;
          if (!icon) continue;
          const rendered = renderExtensionIcon(entry.rootDir, icon);
          if ('dataUrl' in rendered) {
            icons[extensionTabKind(entry.manifest.id, tab.name)] = rendered.dataUrl;
          } else {
            log.warn(`Extension ${entry.manifest.id} tab ${tab.name}: ${rendered.reason}`);
          }
        }
      }
      return {
        success: true,
        data: {
          extensions: extensions.map((entry) => entry.manifest),
          invalid,
          icons,
          appIcons,
          disabled: extensionsService().disabledIds(),
          // The market Apps not updated by themselves (owner 10-19): their 「自动更新」 is off.
          autoUpdateOff: extensionsService().autoUpdateOffIds(),
          // 「退出了、还没再打开」的(#7050):启用着,后台却没在跑。
          quit: quitExtensions(),
          dock: extensionsService().dock(),
          disclosure: disclosureOf(extensions.map((entry) => entry.manifest)),
          // Where each came from (E-05): the session page keeps the preinstalled ones out of every session's tabs, and a
          // chat's card offers an update only of one that came from a chat — the only kind a package from chat may replace.
          origins: extensionsService().origins(),
          // 「始终用它」 for the host's open paths. Unreadable is logged and read as none — the
          // person is asked again — rather than taking the whole list down with it.
          openWith: (() => {
            try {
              return extensionsService().openWithDefaults();
            } catch (error) {
              log.error('The open-with defaults are unreadable; asking again:', error);
              return {};
            }
          })(),
          // Who published each App installed from a chat (摩擦单 F66): the slot's update without a click needs the same one.
          // Unreadable is read as none — every update is then asked about — rather than taking the list down.
          publishers: (() => {
            try {
              return extensionsService().publishers();
            } catch (error) {
              log.error('The extension publishers are unreadable; every update asks:', error);
              return {};
            }
          })(),
        },
      };
    } catch (error) {
      log.error('Failed to list extensions:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Hardens the extension's session and reports it ready. The renderer must
   * await this before mounting the surface: an attachment whose session has
   * not been configured is refused, so mounting first would render nothing and
   * look like a broken extension rather than an unmet precondition.
   */
  activate: async (args: { extensionId: string; tabKind?: string }) => {
    try {
      const installed = extensionsService().get(args.extensionId);
      // Off is enforced here, not only by the renderer not offering the tab: a
      // tab that was open when the switch flipped must not come back to life.
      if (!extensionsService().isEnabled(installed.manifest.id)) {
        throw new Error(`Extension is switched off: ${installed.manifest.id}`);
      }
      // 它的页又被要了 —— 不管从哪儿打开的:「退出」到此为止,后台照常拉起(#7050)。
      if (extensionOpened(installed.manifest.id)) events.emit(extensionsQuitChangedChannel, { quit: quitExtensions() });
      configureExtensionSession({
        extensionId: installed.manifest.id,
        rootDir: installed.rootDir,
        // What it may reach, not what it asked for: a host the user took back
        // is enforced away here and mirrored out of the served CSP.
        networkHosts: extensionsService().grantedHosts(installed.manifest.id),
      });
      return {
        success: true,
        data: {
          partition: extensionPartition(installed.manifest.id),
          entryUrl: extensionResourceUrl(
            installed.manifest.id,
            entryForTab(installed.manifest, args.tabKind)
          ),
        },
      };
    } catch (error) {
      log.error('Failed to activate extension:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Tells the bridge which task a live surface is showing.
   *
   * Only the renderer knows that — a sandboxed page cannot. The extension
   * identity in these arguments is **not** taken on trust: main re-derives it
   * from the webContents' own session and refuses a mismatch, so a wrong binding
   * can never hand one extension another's grants.
   */
  bindSurface: async (args: {
    webContentsId: number;
    extensionId: string;
    /** Absent for a surface in no task (a group's side panel, L3). */
    sessionId?: string;
    tabId: string;
    /** `<extensionId>.<tabName>` — which declared tab this surface draws. */
    tabKind: string;
    /** The file of its session this tab was opened for (an extension claimed its type). */
    filePath?: string;
    /** G1 With `filePath` and no session: the project whose folder that file is in. */
    projectId?: string;
    /** The chat this surface is drawn for, and the chat file it was opened for (L3). */
    chatId?: string;
    itemId?: string;
  }) => {
    try {
      // A page the host draws is the person's to work (owner 10-14); only main's own `app_check` binds one for an agent.
      await bindExtensionSurface({ ...args, operator: { kind: 'person' } });
      return { success: true };
    } catch (error) {
      log.error('Failed to bind extension surface:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 摩擦单 F51: the files of this group that a click opens with this App (their `claimedBy`), newest first — for its
   * card's 「Open」: one file opens straight away, several are listed first in the group's panel.
   */
  groupFilesOpenedBy: async (args: { chatId: string; extensionId: string }) => {
    try {
      const files = await import('@main/core/extensions/app-files');
      const { filesOpenedBy } = await import('@shared/extensions/app-files-core');
      const data = filesOpenedBy(await files.groupFiles(String(args?.chatId ?? '')), String(args?.extensionId ?? ''));
      return { success: true as const, data };
    } catch (error) {
      log.warn('Failed to list the group files an App opens:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * An App opened in a chat that names its file there (API 14 `chatFile`): that file, found or made, as a file opened with
   * that App — so the panel opens it the way it opens any group file, and the two are one tab (owner 10-24).
   */
  appChatFile: async (args: { chatId: string; extensionId: string }) => {
    try {
      const files = await import('@main/core/extensions/app-files');
      return { success: true as const, data: await files.appChatFile(String(args?.chatId ?? ''), String(args?.extensionId ?? '')) };
    } catch (error) {
      log.warn('Failed to find the file an App names in a chat:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * A group file opened from the shell — an App card's 「Open」 (摩擦单 F51), a file link (F10): which App opens it,
   * decided as a click in an App decides (`openerChoice`). The side panel does the opening. `at` (a pill's place, App 引用
   * pill): when one App opens it, that App gets the place as the `link` event a gugu link brings — opened and placed here,
   * as `openExtensionLinkWith` opens and places (148 17:21). Several to choose from: the person picks, and no App is told.
   */
  groupFileOpener: async (args: { chatId: string; itemId: string; at?: Record<string, string> }) => {
    try {
      const files = await import('@main/core/extensions/app-files');
      const chatId = String(args?.chatId ?? '');
      const target = await files.groupFile(chatId, String(args?.itemId ?? ''));
      const choice = files.openerChoice(target.typedName);
      const place = placeFor(choice, args?.at);
      if (place) deliverToOpeningPage(place.candidate.extensionId, placeLink(place.candidate, place.at, target.itemId), { chat: chatId }, target.itemId);
      return { success: true as const, data: { ...target, choice } };
    } catch (error) {
      log.warn('Failed to resolve who opens a group file:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * A link in a session's chat to its working copy's file, with a place (`path#k=v&…`, `#L10` — `classifyFileLink`): the App
   * tab that opens it gets the place as the `link` event a chat file's pill brings (`groupFileOpener`), the same field.
   * Called by the renderer before it opens the tab, so a page still opening finds it waiting.
   */
  sessionFilePlace: async (args: { sessionId: string; filePath: string; extensionId: string; tabKind: string; at: Record<string, string> }) => {
    try {
      const at = Object.fromEntries(Object.entries(args?.at ?? {}).filter(([, value]) => typeof value === 'string'));
      const candidate = { extensionId: String(args?.extensionId ?? ''), tabKind: String(args?.tabKind ?? '') };
      if (Object.keys(at).length > 0) await deliverToSessionFilePage(candidate, at, String(args?.sessionId ?? ''), String(args?.filePath ?? ''));
      return { success: true as const };
    } catch (error) {
      log.warn('Failed to hand a working-copy file link\'s place to its App:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * #7199 A chat folder's file as it is now, as text (chat-folder-text.ts): the 助理 App's 「今天」 page reads the
   * today.json its assistant keeps in their DM's folder. No such file is `data: null`; a failed read says which step (`kind`).
   */
  readChatFolderText: async (args: ChatFileRef) => {
    try {
      const { readChatFolderText } = await import('@main/core/extensions/chat-folder-text');
      return { success: true as const, data: await readChatFolderText(args) };
    } catch (error) {
      log.warn('Failed to read a chat folder file:', error);
      const kind = (error as { kind?: unknown } | null)?.kind;
      return { success: false as const, error: error instanceof Error ? error.message : String(error), kind: typeof kind === 'string' ? kind : 'failed' };
    }
  },

  /**
   * The account revision bus named these files of these groups (the shell passes it on, `useExtensionWorkspaceRevisions`);
   * pages drawn for them hear those files as they are now (#7257).
   */
  groupWorkspaceChanged: async (args: { changes: { chatId: string; itemIds: string[] }[] }) => {
    const changes = (Array.isArray(args?.changes) ? args.changes : [])
      .filter((change) => typeof change?.chatId === 'string' && Array.isArray(change.itemIds))
      .map((change) => ({ chatId: change.chatId, itemIds: change.itemIds.filter((id) => typeof id === 'string') }));
    void notifyGroupWorkspaceChanged(changes);
    return { success: true };
  },

  /** The remembered 「始终用它」 choices (`<context>:<suffix>` → tab kind), for the host's open paths. */
  openWithDefaults: async () => {
    try {
      return { success: true as const, data: extensionsService().openWithDefaults() };
    } catch (error) {
      log.error('Failed to read the open-with defaults:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** The person ticked 「始终用它」 in 「用哪个打开」 (or, with `tabKind: null`, took it back). */
  setOpenWithDefault: async (args: { key: string; tabKind: string | null }) => {
    try {
      extensionsService().setOpenWithDefault(String(args?.key ?? ''), typeof args?.tabKind === 'string' ? args.tabKind : null);
      return { success: true as const };
    } catch (error) {
      log.error('Failed to remember the open-with choice:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 另一台机器上一个 App 的程序发了通知(这台的界面从那台机器的推送收下转来):送给这台机器上绑在那台机器某条会话上的页面。
   * 只收本机界面;别的机器经 rpcOn 叫不到它(device-session-host 的 REMOTE_DENIED_EXTENSIONS)。
   */
  programNotifiedElsewhere: async (args: { deviceId: string; extensionId: string; server: string; method: string; params?: unknown }) => {
    const { deliverProgramNotificationFrom } = await import('./extension-bridge');
    const { deviceId, ...notification } = args;
    await deliverProgramNotificationFrom(deviceId, notification);
    return { success: true };
  },

  /**
   * 同一张页换到另一条会话页上显示(扩展一律 app 级,一个扩展一张页,切会话只挪不重建)。
   * 与 bindSurface 分开:bind 只在这张页第一次出现时做一次;之后每切一次会话走这条。
   */
  retargetSurface: async (args: {
    webContentsId: number;
    sessionId?: string;
    tabId: string;
    filePath?: string;
    chatId?: string;
    itemId?: string;
  }) => {
    try {
      await retargetExtensionSurface(args);
      return { success: true };
    } catch (error) {
      log.error('Failed to retarget extension surface:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * The user picked one of this tab's declared entries; tell the surface.
   *
   * Host chrome is what drew the entry, so host chrome is what reports the
   * click. Refuses for a surface that is not bound rather than dropping it —
   * a menu item that silently does nothing is the same fake as a placeholder
   * button.
   */
  /** 摩擦单 F36: the window saw rows of these chats' members change (who, left or not); the pages sitting in them are told when that moved who is there. */
  chatMembersChanged: async (args: { changes: { chatId: string; memberId: string | null; left: boolean }[] }) => {
    const byChat = new Map<string, { memberId: string | null; left: boolean }[]>();
    for (const change of Array.isArray(args?.changes) ? args.changes : []) {
      if (typeof change?.chatId !== 'string') continue;
      byChat.set(change.chatId, [...(byChat.get(change.chatId) ?? []), { memberId: typeof change.memberId === 'string' ? change.memberId : null, left: change.left === true }]);
    }
    await Promise.all([...byChat].map(([chatId, changes]) => chatMembersChanged(chatId, changes)));
    return { success: true as const };
  },

  invokeCommand: async (args: { webContentsId: number; commandId: string }) => {
    if (!(await invokeExtensionCommand(args.webContentsId, args.commandId))) {
      return { success: false, error: 'This App surface is no longer open' };
    }
    return { success: true };
  },

  /**
   * The pane reports its own box and whether it is on screen.
   *
   * Only the renderer can measure this, and only for the surface it draws — the
   * webContents id is the surface, so a report can never describe someone else's.
   */
  reportLayout: async (args: {
    webContentsId: number;
    visible: boolean;
    width: number;
    height: number;
  }) => {
    updateExtensionSurfaceLayout(args.webContentsId, {
      visible: args.visible,
      width: args.width,
      height: args.height,
    });
    return { success: true };
  },

  /**
   * The renderer tells main what the workspace panel is showing: which task view
   * is on screen, its panes, and the tab each one is on.
   *
   * Reported raw — the agent id and file path of every pane come across as they
   * are, and the **bridge** redacts per surface. Redacting here instead would
   * mean the reporter had to know every installed extension's grants, and the
   * one place that already knows them would have a rival.
   *
   * Main cannot observe any of this: panes are renderer state. Pushed on change.
   */
  setAppState: async (args: {
    activeSessionId: string | null;
    activeProjectId: string | null;
    panes: readonly {
      paneId: string;
      focused: boolean;
      activeTab: { tabId: string; kind: string; agentId?: string; filePath?: string } | null;
    }[];
  }) => {
    setExtensionAppView(args);
    return { success: true };
  },

  /**
   * 市场页的清单:下载站上那份目录的一页,连不上就**照实说连不上** —— 市场只有云端这一个来源
   * (App 市场方案 10-07,owner「按你的来」:离线备份删了;已经装着的 App 照常能用,要离线也有的放进预装)。
   *
   * 连不上时回的仍是这个形状:一页空清单 + `errorKind`,界面据此只画那一句话和「重试」,
   * ❌ 画「这里还没有 App」—— 空清单和读不到清单是两件事。`error` 是原话、只进日志。
   *
   * `page` / `query`:一页一页给界面(翻页要看得见),搜索按名字 / 简介 / id 筛同一份目录。
   */
  market: async (args: { page?: number; query?: string } = {}) => {
    const page = Math.max(0, args.page ?? 0);
    const query = (args.query ?? '').trim();
    try {
      const listing = await cloudExtensionMarket().list({ page, search: query });
      const asItem = ({ manifest, ...cloud }: CloudMarketEntry): MarketListItem => ({
        manifest,
        ref: { extensionId: manifest.id, version: cloud.version },
        cloud,
      });
      const extensions = listing.extensions.map(asItem);
      return {
        success: true,
        data: {
          extensions,
          invalid: listing.invalid.map((entry) => ({ dirName: entry.extensionId, reason: entry.reason })),
          // `errorKind` 是给界面看的(它决定文案),`error` 是原话、只进日志 ——
          // 用户可见文案里 ❌ 不拼内部失败描述(CI policy: copy-leaks-raw-error-slot)。
          errorKind: null as 'unreachable' | null,
          error: null as string | null,
          total: listing.total,
          page,
          hasMore: listing.hasMore,
          fetchedAt: listing.fetchedAt as string | null,
        },
      };
    } catch (cloudError) {
      const reason = cloudError instanceof Error ? cloudError.message : String(cloudError);
      const errorKind = 'unreachable' as const;
      log.warn(`Extension market unreachable: ${reason}`);
      return {
        success: true,
        data: {
          extensions: [] as MarketListItem[],
          invalid: [] as { dirName: string; reason: string }[],
          errorKind,
          error: reason as string | null,
          total: 0,
          page,
          hasMore: false,
          fetchedAt: null as string | null,
        },
      };
    }
  },

  /**
   * 打开 App 页时那一趟:去下载站取一次目录,回来才答 —— 变了 / 没变 / 没取到(market-snapshot.ts)。清单和更新检查
   * 先从手上那份答了,页面拿到 `changed` 再两边一起重读。结果用回答带回:别的机器的推送(`marketRefreshedChannel`)
   * 未必转得到这个窗口。没取到也是一个回答,❌ 失败。
   */
  marketRefresh: async () => ({ success: true as const, data: await cloudExtensionMarket().refresh() }),

  /**
   * 一个扩展当前在清单上的那一版(装着的扩展开详情、更新确认框要它的更新说明)。
   * 界面是分页的,装着的那个未必在已经画出来的页里 —— 所以定点问一次,❌ 不翻页去找。
   * 不在清单上(下架 / 手装的文件夹 / 连不上)就 null。
   */
  marketEntry: async (args: { extensionId: string }) => {
    try {
      const entry = await cloudExtensionMarket().entry(args.extensionId);
      const item: MarketListItem | null = entry
        ? (({ manifest, ...cloud }) => ({
            manifest,
            ref: { extensionId: manifest.id, version: cloud.version },
            cloud,
          }))(entry)
        : null;
      return { success: true, data: item };
    } catch (error) {
      log.warn(`Extension market entry lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** 一个扩展的版本历史(详情面板打开时才取;每一版带这台机器装不装得了、撤回没有)。 */
  marketHistory: async (args: { extensionId: string }) => {
    try {
      return { success: true, data: await cloudExtensionMarket().history(args.extensionId) };
    } catch (error) {
      log.error('Failed to read extension version history:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 这一版包里的 README(可能没有)。这台机器装着的正是这一版,就读装好的那份 —— 从文件夹装的、从聊天里装的、
   * 内置的都一样,包里写了就有(#6950:从前只问市场,文件夹装的永远是「作者没写说明」);没装这一版才问市场。
   * 名字沿用:别的机器按这个名字调它,改名就要动机器之间的协议。
   */
  marketReadme: async (args: { extensionId: string; version: string }) => {
    try {
      const installed = installedAtVersion(args.extensionId, args.version);
      if (!installed) return { success: true, data: { readme: await cloudExtensionMarket().readme(args.extensionId, args.version) } };
      // 从市场装的:读市场上这一版的那份 —— 字一样(版本不可变),但 README 里的截图已改写成下载站地址;
      // 包里那份是相对路径,产品页的「预览」画不出来(#7059)。连不上才读装好的那份。
      // 文件夹、聊天里装的读它自己的(#6950):同 id 同版本的市场那份未必是它。
      const fromMarket =
        extensionsService().origins()[args.extensionId] === 'market'
          ? await cloudExtensionMarket()
              .readme(args.extensionId, args.version)
              .catch(() => null)
          : null;
      return { success: true, data: { readme: fromMarket ?? readBundleReadme(installed.rootDir) } };
    } catch (error) {
      log.error('Failed to read extension README:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 装着的扩展有什么要告诉用户的:有新版 / 装的这版被撤回了 / 扩展已弃用。
   * 启动时查一次(脱离关键路径)、打开设置页时查一次;❌ 轮询、❌ 下载、❌ 安装。
   * 失败只进日志 —— 这是提示,不是功能,连不上云端不该在启动时冒出任何东西。
   */
  marketUpdates: async () => {
    try {
      const { extensions } = extensionsService().list();
      const origins = extensionsService().origins();
      const installed = extensions
        // 预装的跟着咕咕更新,市场的版本也装不进来(installFromDirectory 拒别的包顶替预装的 id):不问。问了,一个比它新的版本
        // 就会在它身上挂出一个按了只会报错的「更新」(10-16 实测,office 0.1.1 对预装 0.1.0)。
        .filter((entry) => origins[entry.manifest.id] !== 'preinstalled')
        .map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          fromMarket: origins[entry.manifest.id] === 'market',
          ...(origins[entry.manifest.id] === 'fork' ? { forkBase: extensionsService().variants(entry.manifest.id).variants.find((variant) => variant.name === extensionsService().variants(entry.manifest.id).active)?.base } : {}),
        }));
      // 定点问装着的这几个,读和市场页同一份目录;「现在的」那份由打开页面时的 marketRefresh 去取。
      const summary = await cloudExtensionMarket().updatesFor(installed);
      return { success: true, data: summary };
    } catch (error) {
      log.warn(`Extension update check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** The market's Apps this machine can install (each its version for here): what a group's 「用 X 打开」 offer looks among. */
  marketOffers: async () => {
    try {
      const offers = await cloudExtensionMarket().offers();
      return { success: true as const, data: offers.map((entry) => ({ manifest: entry.manifest, version: entry.version })) };
    } catch (error) {
      log.warn('The market could not be read for an offer:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 首启默认组里还在路上的 App(161 10-16):群面板对它们会开的文件说「正在装好」。之后的变化推 firstRunArrivingChannel。
   */
  firstRunArriving: async () => {
    const { firstRunArriving } = await import('./first-run-apps');
    return { success: true as const, data: firstRunArriving() };
  },

  /** 再装一次还没装上的那几个(有人打开了它们会开的文件):答在这一趟装完以后,结果看 firstRunArriving。 */
  retryFirstRun: async () => {
    try {
      const { runFirstRunApps } = await import('./first-run-apps');
      await runFirstRunApps();
      return { success: true as const };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 从市场装一个 App —— 设置页、群里的「用 X 打开」、首启默认组都走这一个(installExtensionFromMarket):
   * 下载、比对指纹、解包、读 manifest、问人(`consent: return` 把要问的交回、调用方自己问完再带着 `given` 来)、装上。
   * 下载进度推给界面(marketDownloadProgressChannel),卡片据此写「下载中 42%」。
   */
  installFromMarket: async (args: MarketInstall) => {
    try {
      // Asking nobody is main's own, for the first-run set (first-run-apps.ts): never a window's to ask for.
      if (args?.consent?.kind === 'gugu') throw new Error('An App is put in without asking only by gugu itself (the first-run set)');
      return { success: true, data: await installExtensionFromMarket(args) };
    } catch (error) {
      log.error('Failed to install an App from the market:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** #6646 The package's bytes, for the chat to send like any other attachment; `save` also writes them where the person picks. */
  packInstalled: async (args: { extensionId: string; save?: boolean }) => {
    try {
      const { bytes, sha256, fileName } = await packInstalledExtension(extensionsService(), args.extensionId);
      // TEST-ONLY, env-gated (GUGU_SESSION_TEST_HOOKS=1): the native save dialog cannot be driven, so a test names the file.
      const saved = !args.save ? null
        : process.env.GUGU_SESSION_TEST_HOOKS === '1' && process.env.GUGU_EXTENSION_EXPORT_PATH
          ? process.env.GUGU_EXTENSION_EXPORT_PATH
          : (await appService.showDownloadSaveDialog(fileName)) ?? null;
      if (saved) fs.writeFileSync(saved, bytes);
      return { success: true, data: { bytes: new Uint8Array(bytes), sha256, fileName, mimeType: EXTENSION_ARCHIVE_MIME, saved } };
    } catch (error) {
      log.error('Failed to pack an installed extension:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * A folder the person picked, installed the one way every install goes (install-prepared.ts): `return` hands back what
   * it would ask (`asks` false: nothing — the click was the yes), `given` installs these bytes only (the digest the sheet
   * was read from), given where they ticked. Only a folder: a market App installs the one way (`installFromMarket`) — this
   * records no folder as the market's, gugu's (复核 10-15).
   */
  installFromFolder: async (args: { sourceDir: string; consent: HandedConsent }) => {
    try {
      const service = extensionsService();
      const { manifest, manifestDigest } = service.inspectDirectory(args.sourceDir);
      const variant = await prepareForkVariant(args.sourceDir);
      const preparedVariant = variant ? prepareVariant(args.sourceDir, variant) : null;
      const plan = installPlan(service, manifest, variant ? 'fork' : 'folder');
      const given = await import('@main/core/extensions/app-given');
      const done = await installPrepared(preparedVariant ?? {
        dir: args.sourceDir,
        manifest,
        manifestDigest,
        origin: 'folder',
        // A folder's App is the account installing it (app-identity.ts).
        publisher: await (await import('@main/core/extensions/app-files')).folderPublisher(),
        asks: plan.asks,
        sheet: { installed: plan.approved, revokedPermissions: plan.revokedPermissions },
        places: { first: !plan.displaced, identity: await given.ownInstallIdentity(manifest.id, 'folder') },
      }, args.consent);
      return { success: true, data: done.outcome === 'confirmed' ? { outcome: done.outcome, manifest: done.installed.manifest } : done };
    } catch (error) {
      log.error('Failed to install extension:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * D-30 「给哪些 agent」: the places an App can be given at, ticked where it is now (its row in 「App」); with no App, the
   * places an install asks about, `chatId`'s ticked at first (else every agent here), and where the account already gave
   * the App being installed (`app`) ticked as they are.
   */
  appPlaces: async (args: { extensionId?: string; chatId?: string; app?: { id: string; origin: 'market' | 'folder' } }) => {
    try {
      const given = await import('@main/core/extensions/app-given');
      if (args?.extensionId) return { success: true as const, data: await given.appPlaces(String(args.extensionId)) };
      const identity = args?.app ? await given.ownInstallIdentity(String(args.app.id), args.app.origin === 'market' ? 'market' : 'folder') : null;
      const { places } = await given.installPlaces(identity, args?.chatId ? String(args.chatId) : undefined);
      return { success: true as const, data: places };
    } catch (error) {
      log.warn('Failed to read which agents an App is given to:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** The person's choice of which agents get an App (its row in 「App」): the whole set of places. */
  setAppPlaces: async (args: { extensionId: string; enableIn: string[] }) => {
    try {
      const given = await import('@main/core/extensions/app-given');
      await given.setAppPlaces(String(args?.extensionId ?? ''), Array.isArray(args?.enableIn) ? args.enableIn.map(String) : []);
      return { success: true as const };
    } catch (error) {
      log.warn('Failed to change which agents an App is given to:', error);
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** #6646 The chat card's Install: main downloads, checks and asks, the same way an agent's install does. */
  // D-31 `consent`: another device asks the person and installs it here (AttachmentInstall.consent).
  installAttachment: async (args: AttachmentInstall) => {
    try {
      return { success: true, data: await installExtensionFromAttachment(args) };
    } catch (error) {
      log.error('Failed to install an extension package from chat:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Withdraws (or restores) one declared permission — a network host or a
   * capability. The extension keeps running: saying no to one thing must not
   * require removing the extension. The session is reconfigured in place, so
   * the change binds immediately for a surface that is already open.
   */
  setPermissionGranted: async (args: {
    extensionId: string;
    permission: string;
    granted: boolean;
  }) => {
    try {
      const service = extensionsService();
      service.setPermissionGranted(args.extensionId, args.permission, args.granted);
      const installed = service.get(args.extensionId);
      configureExtensionSession({
        extensionId: installed.manifest.id,
        rootDir: installed.rootDir,
        networkHosts: service.grantedHosts(installed.manifest.id),
      });
      // The filter binds at once; the CSP does not — it was stamped when the
      // document loaded. Reloading is what stops an open surface from carrying a
      // header that names a host the session has just started blocking.
      //
      // Capabilities need no reload: the bridge asks for the granted set on every
      // call, so a withdrawn capability stops working on the next call either way.
      reloadExtensionSurfaces(installed.manifest.id);
      return { success: true, data: { revoked: service.revokedPermissions(args.extensionId) } };
    } catch (error) {
      log.error('Failed to change extension permission:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** The Apps on the far-left rail, in order: pinned, taken off and reordered by one write of the list. */
  setDock: async (args: { ids: string[] }) => {
    try {
      return { success: true, data: { dock: extensionsService().setDock(args.ids) } };
    } catch (error) {
      log.error('Failed to change the dock:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Switches an extension off or on — the rung between installed and
   * uninstalled. Off tears down its open surfaces (they fall back to the
   * placeholder in the renderer, which withdraws the providers); on needs
   * nothing here, the next activate hardens the session as usual.
   */
  setEnabled: async (args: { extensionId: string; enabled: boolean }) => {
    try {
      const service = extensionsService();
      service.setEnabled(args.extensionId, args.enabled);
      if (!args.enabled) reloadExtensionSurfaces(args.extensionId);
      if (forgetQuit(args.extensionId)) events.emit(extensionsQuitChangedChannel, { quit: quitExtensions() });
      // 后台与**启用状态**同生死,不与 tab 同生死:停用即销毁,启用即拉起。
      syncExtensionBackgrounds();
      // Switched back on, it is brought up to date at once, as VS Code checks on an enablement change
      // (https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L1157-L1161 ).
      if (args.enabled) void autoUpdateApps();
      // 摩擦单 F87: who opens which group file changed with it — open group pages list again.
      void notifyInstalledAppsChanged();
      return { success: true, data: { disabled: service.disabledIds() } };
    } catch (error) {
      log.error('Failed to switch extension:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * An App's 「自动更新」 (owner 10-19, VS Code's per-extension 「Auto Update」). Back on, a pass runs at once — as VS Code
   * updates it the moment its switch is turned on
   * (https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L2425-L2515 ).
   */
  setAutoUpdate: async (args: { extensionId: string; on: boolean }) => {
    try {
      const service = extensionsService();
      service.setAutoUpdate(args.extensionId, args.on);
      if (args.on) void autoUpdateApps();
      return { success: true, data: { autoUpdateOff: service.autoUpdateOffIds() } };
    } catch (error) {
      log.error('Failed to switch an App\'s auto-update:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * 左栏右键「退出」(#7050,照 macOS 程序坞):后台停下,并且停着直到它再被打开(`activate`)。
   * 它摆着的地方由界面收掉 —— 那些是界面的事;这里只管主进程里那个看不见的常驻实例。启用状态不变。
   */
  quit: async (args: { extensionId: string }) => {
    try {
      const installed = extensionsService().get(args.extensionId);
      quitExtension(installed.manifest.id);
      const quit = quitExtensions();
      events.emit(extensionsQuitChangedChannel, { quit });
      return { success: true, data: { quit } };
    } catch (error) {
      log.error('Failed to quit an App:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** Whether new sessions list this extension's agent tools up front; sessions already open keep theirs. */
  setDisclosure: async (args: { extensionId: string; level: ExtensionDisclosure }) => {
    try {
      extensionsService().setDisclosure(args.extensionId, args.level);
      return { success: true, data: { level: extensionsService().disclosure(args.extensionId) } };
    } catch (error) {
      log.error('Failed to change extension disclosure:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * #6387 How each extension's agent programs are doing: how many run now, and the last one that
   * failed, as recorded by gugu, which runs them (#6615).
   */
  openSettings: async (args: { extensionId: string }) => {
    try {
      const service = extensionsService();
      const installed = service.get(args.extensionId);
      if (!service.isEnabled(args.extensionId)) throw new Error(`Extension is switched off: ${args.extensionId}`);
      if (!installed.manifest.contributes.tabs.some((tab) => tab.hostPage === 'settings')) throw new Error('This App has no host settings page');
      if (extensionOpened(args.extensionId)) events.emit(extensionsQuitChangedChannel, { quit: quitExtensions() });
      return { success: true as const, data: service.settings(args.extensionId) };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  settings: async (args: { extensionId: string }) => {
    try {
      return { success: true as const, data: extensionsService().settings(args.extensionId) };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  setSettings: async (args: { extensionId: string; settings: unknown }) => {
    try {
      const data = extensionsService().setSettings(args.extensionId, args.settings);
      void retireExtensionPrograms(args.extensionId).catch((error: unknown) => log.warn('App program did not retire after settings changed:', error));
      return { success: true as const, data };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },

  agentStatus: async () => {
    try {
      const { extensions } = extensionsService().list();
      return {
        success: true,
        data: Object.fromEntries(
          extensions
            .filter((entry) => (entry.manifest.contributes.mcpServers ?? []).length > 0)
            .map((entry) => [entry.manifest.id, extensionProgramStatus(entry.manifest.id)])
        ),
      };
    } catch (error) {
      log.error('Failed to read extension agent status:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * #7059 产品页「装上后多了什么 · 给 agent 的工具」:这个 App 的程序给 agent 的那几样,名字和一句说明(照 Claude
   * 连接器目录的工具清单)。只回装着、启用、没收回「给 agent 工具」的(不然 null:它此刻给不了);问的是程序自己,
   * 与会话起来时读工具清单是同一件事 —— 读过的按版本记着,没在跑就起一次。没装的 App 没有程序可问,产品页只说带了哪个程序。
   */
  agentTools: async (args: { extensionId: string }) => {
    try {
      if (extensionPrograms.agentToolsRefusal(args.extensionId)) return { success: true, data: null };
      const programs = extensionPrograms.installed().filter((program) => program.extensionId === args.extensionId);
      // 一个程序起不来,别的程序的工具照样列(它没起来的原因在「给 agent 的程序没能启动」那一句里)。
      const listed = await Promise.allSettled(programs.map((program) => extensionPrograms.tools(program)));
      return {
        success: true,
        data: listed.flatMap((result) =>
          result.status === 'fulfilled'
            ? result.value
                .filter((tool) => toolVisibleTo(tool, 'model'))
                .map((tool) => ({ name: tool.name, about: tool.description ? firstSentence(tool.description.trim()) : null }))
            : []
        ),
      };
    } catch (error) {
      log.warn('Failed to list an App\'s agent tools:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  revoked: async () => {
    try {
      const service = extensionsService();
      const { extensions } = service.list();
      return {
        success: true,
        data: Object.fromEntries(
          extensions.map((entry) => [
            entry.manifest.id,
            service.revokedPermissions(entry.manifest.id),
          ])
        ),
      };
    } catch (error) {
      log.error('Failed to read extension permissions:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  uninstall: async (args: { extensionId: string }) => {
    try {
      extensionsService().uninstall(args.extensionId);
      // Its tabs may still be open. Unbound in the same tick as the delete, so no callback of theirs
      // runs against an extension that is gone — and app_check's kept pages of it go.
      unbindExtensionSurfaces(args.extensionId);
      closeCheckPages({ extensionId: args.extensionId });
      // The bundle is gone; its storage must go with it, or a reinstall would
      // silently inherit state the user believed they had removed.
      await clearExtensionSessionData(args.extensionId);
      // #6387 其数据文件夹(页面与它的 MCP 程序共用的那份)和程序跑的冻结副本同理,随扩展一起走:程序像升级时的
      // 旧版一样退出池子(在途的调用先跑完),退干净了当场删。10-06 实撞:卸载后程序还开着聊天文件,下一帧把咕咕整个
      // 带走了。删之前再看一眼:这期间又装上了,就不删新装的那份。
      const { extensionId } = args;
      void retireExtensionPrograms(extensionId).then(() => {
        if (extensionsService().isInstalled(extensionId)) return;
        removeUninstalledLeftovers(app.getPath('userData'), extensionDataRoot(extensionId), extensionId);
      }).catch((error: unknown) => log.error('extensions: the files of an uninstalled App could not be removed', { extensionId, error }));
      if (forgetQuit(extensionId)) events.emit(extensionsQuitChangedChannel, { quit: quitExtensions() });
      syncExtensionBackgrounds();
      // #6264 卸载也可能来自另一台桌面(设备 RPC):这台的窗口据此撤下 provider,开着的 tab 退回占位。
      events.emit(extensionsInventoryChangedChannel, { extensionId: args.extensionId });
      // 摩擦单 F87: its files are nobody's to open now — open group pages list again.
      void notifyInstalledAppsChanged();
      return { success: true };
    } catch (error) {
      log.error('Failed to uninstall extension:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
