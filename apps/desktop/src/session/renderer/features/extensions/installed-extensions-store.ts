import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { getLocaleSnapshot, subscribeLocale } from '@/i18n';
import {
  declaredContexts,
  extensionTabKind,
  type ExtensionManifest,
  type ExtensionTabKind
} from '@shared/extensions/manifest';
import { localizedManifestText } from '@shared/extensions/catalog';
import type { MarketUpdatesSummary } from '@shared/extensions/market';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';

/**
 * What is installed, as the renderer sees it. The main process owns the truth
 * (it scans the extensions directory); this mirrors it so the tab chrome can
 * render entries without an await on every menu open. Refs #2374.
 */

/** The host's settings page for an App (`hostPage: 'settings'`) is a form of rows: as narrow as a chat's info. */
const HOST_SETTINGS_SIDE_WIDTH = 360;

export interface ExtensionTabContributionEntry {
  /** Tab kind under which this contribution registers: `<extensionId>.<tabName>`. */
  kind: ExtensionTabKind;
  extensionId: string;
  extensionName: string;
  title: string;
  hostSettings?: boolean;
  /** Its width beside another page (manifest `sideWidth`; the host's settings page is a narrow form): none = half. */
  sideWidth?: number;
  /**
   * Host-produced PNG for this tab, or null for the generic mark. A data URL
   * rather than a path: the bytes are re-encoded in main precisely so the
   * privileged renderer never fetches anything an extension shipped.
   */
  iconDataUrl: string | null;
  /** False while the extension is switched off: listed, not offered. */
  enabled: boolean;
  /** Shipped with gugu (origin `preinstalled`): drawn only from the host's own entries, never a session tab. */
  preinstalled: boolean;
  /**
   * The tab opens files (it claims some, in a task or a group): it is opened FOR a file, and a page of it with no file
   * has nothing to show — so it is never a tab of its own in a session (摩擦单 F95: 「Open a .todo-kanban.json file」 and
   * an uncaught error, in a tab nobody asked for; F3 for the group-only ones, whose session tab made a page at install).
   */
  forFiles: boolean;
  /** One page in each task (`perSession`): each task keeps its own, so it is never moved from one task to another. */
  perSession: boolean;
}

/** 这份清单问的是哪台机器(本机 = `rpc.extensions`;另一台咕咕桌面 = 经设备 RPC,#6264)。 */
export type InstalledExtensionsApi = Pick<typeof rpc.extensions, 'list' | 'marketUpdates' | 'setDisclosure' | 'setAutoUpdate'>;

/** What installed is, as main lists it — and the phone's App store says it in the same shape (L9). */
export type InstalledExtensionsList = NonNullable<Awaited<ReturnType<InstalledExtensionsApi['list']>>['data']>;

export type ExtensionDisclosureLevel = 'full' | 'progressive';

/**
 * The preinstalled workspace App (apps/desktop/preinstalled-apps/workspace; 群文件夹 / 文件夹 to people, chatFolderName.ts). It stays an App in code, but it is
 * the chat's own folder, not something one installs or removes, so the App lists leave it out (owner 10-10).
 */
export const WORKSPACE_APP_ID = 'workspace';

/** An App as the far-left rail draws it: its icon (or, absent, its first letter) and the page it opens. */
export interface RailApp {
  extensionId: string;
  name: string;
  kind: string;
  iconDataUrl: string | null;
}

export class InstalledExtensionsStore {
  manifests: ExtensionManifest[] = [];
  /** Bundles present but unreadable — surfaced rather than silently skipped. */
  invalid: { dirName: string; reason: string }[] = [];
  /** Tab kind → host-rendered icon. Absent means the tab draws the generic mark. */
  icons: Record<string, string> = {};
  /** App id → its own icon, host-rendered at the rail's size. Absent means the rail draws its first letter. */
  appIcons: Record<string, string> = {};
  /** The Apps pinned to the far-left rail, in order (this machine's dock). */
  dock: string[] = [];
  /** Ids the user has switched off — installed, listed, but not offered (#5265). */
  disabled: string[] = [];
  /** Market Apps not updated by themselves (owner 10-19): switched off, or an older version picked. Main's, mirrored. */
  autoUpdateOff: string[] = [];
  /** Ids quit from the rail and not opened since (#7050): on, but their background is not running. Main's, mirrored. */
  quit: string[] = [];
  /**
   * Where each installed App came from (E-05): `preinstalled` for the ones gugu ships and installs itself
   * (preinstalled-apps.ts); none for one installed before origins were kept.
   */
  origins: Record<string, ExtensionOrigin> = {};
  /** Extensions that give agents tools: listed up front in new sessions (`full`) or looked up on demand. */
  disclosure: Record<string, ExtensionDisclosureLevel> = {};
  /** 「始终用它」: `<context>:<suffix>` → tab kind (or the built-in editor), kept in main. */
  openWithDefaults: Record<string, string> = {};
  /** Who published each App installed from a chat (摩擦单 F66): `{ [extensionId]: { id, name } }`. */
  publishers: Record<string, { id: string; name?: string }> = {};
  /** The interface language, mirrored so the names below follow a switch: an App is called what its `localized` says there. */
  locale: string = getLocaleSnapshot().resolvedLocale;
  isLoaded = false;
  /**
   * 云端那口对装着的这些扩展要说的话(#5410):有新版 / 装的这版被撤回了 / 已弃用。
   * `null` = 还没查过,不是「查过、什么都没有」—— 后者是三个空对象的
   * `MarketUpdatesSummary`。查询失败也留 `null`,静默:这是提示,不是功能,连不上云端
   * 不该在启动时冒出任何东西(product spec)。
   */
  updates: MarketUpdatesSummary | null = null;

  constructor(private readonly api: InstalledExtensionsApi = rpc.extensions) {
    makeAutoObservable<InstalledExtensionsStore, 'api'>(this, { api: false });
    subscribeLocale(() => runInAction(() => { this.locale = getLocaleSnapshot().resolvedLocale; }));
  }

  /** A default App page uses its localized name; specifically named subpages keep their contribution title. */
  tabTitle(kind: string): string | undefined {
    const tab = this.allTabContributions.find((entry) => entry.kind === kind);
    return tab && (this.mainTabOf(tab.extensionId)?.kind === kind ? tab.extensionName : tab.title);
  }

  /** How wide this App page is beside another (`sideWidth`); undefined: half, a peer. */
  sideWidth(kind: string): number | undefined {
    return this.allTabContributions.find((entry) => entry.kind === kind)?.sideWidth;
  }

  /** Every declared tab, preinstalled Apps' included — what a lookup by kind reads. */
  get allTabContributions(): ExtensionTabContributionEntry[] {
    return this.manifests.flatMap((manifest) => {
      const name = localizedManifestText(manifest, this.locale).name;
      return manifest.contributes.tabs.map((tab) => ({
        kind: extensionTabKind(manifest.id, tab.name),
        extensionId: manifest.id,
        extensionName: name,
        title: tab.hostPage ? name : tab.title,
        hostSettings: tab.hostPage === 'settings',
        sideWidth: tab.hostPage === 'settings' ? HOST_SETTINGS_SIDE_WIDTH : tab.sideWidth,
        iconDataUrl: this.icons[extensionTabKind(manifest.id, tab.name)] ?? null,
        enabled: this.isEnabled(manifest.id),
        preinstalled: this.isPreinstalled(manifest.id),
        forFiles: declaredContexts(tab).length > 0,
        perSession: tab.perSession === true,
      }));
    });
  }

  /**
   * The tabs a task session can have of their own: the user's Apps' tabs that open no file, of the Apps that are on. A
   * preinstalled App is not one of them — it appears only where the host puts it (the group's workspace entry,「用 X 打开」,
   * later the dock), never as a tab in every session (统筹 09-29, L3); decided by origin, not manifest. Nor is a tab that
   * opens files (`forFiles`). A switched-off App is left out, not greyed: the menus that open a tab list what can be
   * opened (owner 10-20); switching it on is the「App」page's.
   */
  get enabledTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled && !entry.preinstalled && !entry.forFiles);
  }

  /** Every enabled App's resident page, preinstalled ones included: what the resident layer keeps alive. */
  get residentTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled);
  }

  /**
   * An App's page of its own — its first tab that opens no file and is not one per task — or null: what the rail opens, if
   * it can be pinned. A page per task is in many places at once, so it has no one place for the rail to go to.
   */
  mainTabOf(extensionId: string): ExtensionTabContributionEntry | null {
    return this.allTabContributions.find((entry) => entry.extensionId === extensionId && !entry.forFiles && !entry.perSession) ?? null;
  }

  /** What the rail shows: the pinned Apps that are installed, on, and have a page of their own, in the person's order. */
  get dockedApps(): RailApp[] {
    return this.dock.flatMap((extensionId) => this.railApp(extensionId) ?? []);
  }

  /** Every App the rail can open, pinned or not, in the order they were installed: what a right click on 「App」 lists. */
  get openableApps(): RailApp[] {
    return this.manifests.flatMap((manifest) => this.railApp(manifest.id) ?? []);
  }

  /** An App as the rail draws it, if the rail can open it: installed, on, with a page of its own. */
  private railApp(extensionId: string): RailApp | null {
    const main = this.mainTabOf(extensionId);
    if (!main || !main.enabled) return null;
    return { extensionId, name: main.extensionName, kind: main.kind, iconDataUrl: this.appIcons[extensionId] ?? null };
  }

  applyDock(dock: readonly string[]): void {
    this.dock = [...dock];
  }

  applyQuit(quit: readonly string[]): void {
    this.quit = [...quit];
  }

  /** Shipped with gugu (origin `preinstalled`): updated with gugu, never uninstalled or switched off here. */
  isPreinstalled(extensionId: string): boolean {
    return this.origins[extensionId] === 'preinstalled';
  }

  isEnabled(extensionId: string): boolean {
    return !this.disabled.includes(extensionId);
  }

  /** Whether this App is updated by itself: only a market App has the switch (null for the rest). */
  autoUpdates(extensionId: string): boolean | null {
    return this.origins[extensionId] === 'market' ? !this.autoUpdateOff.includes(extensionId) : null;
  }

  /** An App's 「自动更新」, as main keeps it. Back on, main updates it at once; the list says so when it lands. */
  async setAutoUpdate(extensionId: string, on: boolean): Promise<void> {
    const result = await this.api.setAutoUpdate({ extensionId, on });
    if (!result.success || !result.data) throw new Error(result.error ?? 'auto-update switch refused');
    const { autoUpdateOff } = result.data;
    runInAction(() => {
      this.autoUpdateOff = autoUpdateOff;
    });
  }

  /**
   * 设置左栏「扩展」徽标上的那个数字:有更新 / 被撤回 / 已弃用的 id 并集大小
   * (同一个扩展可能同时命中好几类,只算一次)。查询失败或还没查过时是 0 ——
   * 徽标本身就是可选的提示,不该在没数据时画出一个假的零来抢注意力,
   * 更不该画出一个错的数。
   * 不自动更新的(人自己停在旧版的)照样算(owner 10-19「对齐 vscode」):VS Code 的 `outdated` 只比版本号、不看 pinned,
   * 钉住的照样有「Update」、照样进角标 ——
   * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L338-L360 ;
   * 停用的不算新版(角标只数启用着的,同一段 L1052;它在「已停用」组里,installedGroupOf),撤回 / 弃用停用了也算 ——
   * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsViewlet.ts#L1040-L1071 。
   */
  get updateCount(): number {
    if (!this.updates) return 0;
    const ids = new Set<string>([
      ...Object.keys(this.updates.updates).filter((id) => this.isEnabled(id)),
      ...Object.keys(this.updates.forkBehind ?? {}).filter((id) => this.isEnabled(id)),
      ...Object.keys(this.updates.yanked),
      ...Object.keys(this.updates.deprecated),
    ]);
    return ids.size;
  }

  /**
   * 装着的这些扩展有什么要告诉用户的。启动时查一次、打开设置页时查一次
   * (调用方负责挑时机);❌ 轮询。失败只进日志 —— 这是提示,不是功能。
   */
  async checkUpdates(): Promise<void> {
    try {
      const result = await this.api.marketUpdates();
      if (!result.success || !result.data) {
        throw new Error(result.error ?? 'update check failed');
      }
      runInAction(() => {
        this.updates = result.data;
      });
    } catch (error) {
      log.warn('extension update check skipped:', error);
    }
  }

  applyDisabled(disabled: readonly string[]): void {
    this.disabled = [...disabled];
  }

  /** Optimistic, with rollback; the server's answer is what stays. */
  async setDisclosure(extensionId: string, level: ExtensionDisclosureLevel): Promise<void> {
    const before = this.disclosure[extensionId];
    if (!before) throw new Error(`${extensionId} gives agents no tools`);
    this.disclosure = { ...this.disclosure, [extensionId]: level };
    try {
      const result = await this.api.setDisclosure({ extensionId, level });
      if (!result.success || !result.data) throw new Error(result.error ?? '');
      const settled = result.data.level;
      runInAction(() => {
        this.disclosure = { ...this.disclosure, [extensionId]: settled };
      });
    } catch (error) {
      runInAction(() => {
        this.disclosure = { ...this.disclosure, [extensionId]: before };
      });
      throw error;
    }
  }

  /** A 「始终用它」 kept (or, `null`, let go — 摩擦单 F73) where main keeps it too: this window reads it at once. */
  noteOpenWithDefault(key: string, tabKind: string | null): void {
    const { [key]: _dropped, ...rest } = this.openWithDefaults;
    this.openWithDefaults = tabKind === null ? rest : { ...rest, [key]: tabKind };
  }

  manifestFor(extensionId: string): ExtensionManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === extensionId);
  }

  /** An installed App's name as the person reads it: in the interface language, as its manifest's `localized` says it there. */
  appName(extensionId: string): string | undefined {
    const manifest = this.manifestFor(extensionId);
    return manifest && localizedManifestText(manifest, this.locale).name;
  }

  async load(): Promise<void> {
    const result = await this.api.list();
    if (!result.success || !result.data) {
      throw new Error(result.error ?? 'Failed to list extensions');
    }
    this.applyList(result.data);
  }

  /**
   * What is installed, as a list says it: main's (`load`), or on the phone its own App store's (phoneApps.ts, L9) — one
   * store, so the card, the group's panel and 「用 X 打开」 read the same thing on both.
   */
  applyList(list: InstalledExtensionsList): void {
    const { extensions, invalid, icons, appIcons, disabled, autoUpdateOff, quit, dock, disclosure, origins, openWith, publishers } = list;
    runInAction(() => {
      this.manifests = extensions;
      this.invalid = invalid;
      this.icons = icons ?? {};
      this.appIcons = appIcons ?? {};
      this.dock = dock ?? [];
      this.disabled = disabled ?? [];
      this.autoUpdateOff = autoUpdateOff ?? [];
      this.quit = quit ?? [];
      this.origins = origins ?? {};
      this.disclosure = disclosure ?? {};
      this.openWithDefaults = openWith ?? {};
      this.publishers = publishers ?? {};
      this.isLoaded = true;
    });
  }
}

export const installedExtensionsStore = new InstalledExtensionsStore();
