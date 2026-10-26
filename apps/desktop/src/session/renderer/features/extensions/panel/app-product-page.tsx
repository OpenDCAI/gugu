import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  ChevronLeft,
  ExternalLink,
  Eye,
  Globe,
  LayoutGrid,
  Lock,
  MessageCircle,
  Moon,
  Pencil,
  Share2,
  Shield,
  ShieldCheck,
  Terminal,
  Users,
  Wrench,
} from '@/lib/icons';
import './extensions-panel.css';
import './app-store.css';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Switch } from '@renderer/lib/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';
import { givesAgentTools } from '@shared/extensions/app-places';
import {
  declaredPermissions,
  localizedManifestText,
  manifestLanguages,
  marketCategoryOf,
  permissionSide,
  type DeclaredPermission,
} from '@shared/extensions/catalog';
import { claimedSuffixes, compareExtensionVersions, type ExtensionCapability, type ExtensionManifest } from '@shared/extensions/manifest';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import {
  marketSourceLabel,
  marketSourceUrl,
  type CloudMarketEntryMeta,
  type MarketSourceRef,
  type MarketVersionHistoryEntry,
} from '@shared/extensions/market';
import { describeCapability, programDetails, type SessionTranslate } from '../extension-consent';
import type { ExtensionsApi } from '../extensions-host';
import type { ExtensionDisclosureLevel } from '../installed-extensions-store';
import { AppGivenSection } from './app-given-section';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { AppMoreMenu } from './app-more-menu';
import { AppShelfRow } from './app-shelf';
import { AppVariantList, type AppVariantRow } from './app-variant-list';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';
import { InstalledRowNoticeLine, programFailureText, type InstalledRowNotice } from './installed-extension-row';

/**
 * What the page is about: a manifest, plus where it came from. `installRef` is
 * set when the market carries it and names the version an install from here
 * fetches (#5410); `installed` is the copy on disk, if any. `cloud` carries
 * everything only the market knows about *this* version (icon, compat,
 * deprecation, release notes, size, where its code is) — null for an App
 * installed from a folder or a chat with no market copy. Refs #5265, #5410.
 */
export interface ExtensionDetailSubject {
  manifest: ExtensionManifest;
  installed: ExtensionManifest | undefined;
  installRef: MarketSourceRef | undefined;
  cloud?: CloudMarketEntryMeta | null;
}

type Loadable<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

export type ProductPageApi = Pick<typeof rpc.extensions, 'marketReadme' | 'marketHistory'> &
  Partial<Pick<ExtensionsApi, 'agentTools'>>;

/**
 * 一个 App 的产品页(#7059,取代原来的居中详情框):在「App」那一栏里整页铺开,左上「‹ App」回到清单。
 * 版面照 Google Play 的应用页(owner 10-10「这个是我想要的」):头上大字名字、发布方、一排要点、大按钮,右边大图标;
 * 下面左栏 截图一排 → 关于此 App(这个语言的简介;→ 打开 README 全文和信息表)→「对 agent 说」→ 新功能和版本历史
 * → 装上后多了什么 → 权限(它能看 / 它能做,每项能单独收回,照 Slack);右栏 审核那张卡、链接、类似 App。
 * 名字、简介、示例句跟界面语言走(manifest `localized`);它还写了别的语言,「关于」旁边给一个切换。
 * 读完再决定的东西都在这一页,装、开、更新也在这一页头上那一颗。
 */
export function AppProductPage({
  subject,
  iconDataUrl,
  enabled,
  lifecycle,
  pending,
  pendingPercent,
  locale,
  translate,
  machine,
  api = rpc.extensions,
  readOnly = false,
  justInstalled = false,
  notice,
  variants,
  onSwitchVariant,
  onCopyForkPrompt,
  revoked = [],
  pendingPermissions = [],
  agentStatus,
  disclosure,
  givenApi,
  docked = false,
  onBack,
  onLifecycle,
  onInstallVersion,
  onTogglePermission,
  onDisclosureChange,
  onAsk,
  onBrowseReplacement,
  onOpenExternal = confirmOpenExternalLink,
  backgroundSupported = true,
  permissionRevocationSupported = true,
  phoneAgentCapabilities = [],
  similar = [],
  menu,
}: {
  subject: ExtensionDetailSubject;
  /** The installed copy's icon as main re-encoded it, drawn when the market has none. */
  iconDataUrl?: string;
  enabled: boolean;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  locale: string;
  translate: SessionTranslate;
  /** 看的是另一台机器的 App 时,那台的名字:权限那一张卡如实写它,❌ 写「这台电脑」。不给 = 本机。 */
  machine?: string;
  /** README、版本历史、工具清单问哪台机器(#6264)。不给 = 本机。 */
  api?: ProductPageApi;
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):照旧看,动作全灰。 */
  readOnly?: boolean;
  /** 刚在这一页装好:头下面一句「装好了」和去哪找它。 */
  justInstalled?: boolean;
  /** 云端那口对装着这一版要说的话(有新版 / 撤回 / 停止维护)。 */
  notice?: InstalledRowNotice;
  variants?: { active: string; variants: readonly AppVariantRow[] };
  onSwitchVariant?: (name: string) => void;
  onCopyForkPrompt?: (variant: AppVariantRow, update?: Extract<InstalledRowNotice, { kind: 'forkBehind' }>) => void;
  revoked?: readonly string[];
  pendingPermissions?: readonly string[];
  agentStatus?: ExtensionAgentStatus;
  disclosure?: ExtensionDisclosureLevel;
  givenApi?: Pick<ExtensionsApi, 'appPlaces' | 'setAppPlaces'>;
  docked?: boolean;
  onBack: () => void;
  onLifecycle: () => void;
  onInstallVersion: (ref: MarketSourceRef) => void;
  /** 装着的才给:每一项「收回 / 恢复」。 */
  onTogglePermission?: (permission: string, granted: boolean) => void;
  onDisclosureChange?: (level: ExtensionDisclosureLevel) => void;
  /** 「对 agent 说」点一句 = 新建任务、这句已填好;不给(看的是别的机器)就只读。 */
  onAsk?: (text: string) => void;
  /** Opens a web link on the viewing device. Desktop retains its confirmation dialog. */
  onOpenExternal?: (url: string) => void;
  /** The phone has no persistent App background-page host. */
  backgroundSupported?: boolean;
  /** Whether this host lets people take back individual permissions after installation. */
  permissionRevocationSupported?: boolean;
  /** Agent capabilities declared by the App, before the phone removes them from its permission list. */
  phoneAgentCapabilities?: readonly ExtensionCapability[];
  onBrowseReplacement?: (extensionId: string) => void;
  /** 右栏「类似 App」:市场里同一类的别的 App(照 Google Play),点一个 = 换到它的产品页。 */
  similar?: { id: string; name: string; publisher: string; line: string; iconUrl?: string | null; onOpen: () => void }[];
  menu: {
    onToggleDock?: () => void;
    onOpenInWindow?: () => void;
    onForward?: () => void;
    onToggleEnabled?: (enabled: boolean) => void;
    /** 市场装的才有:「自动更新」(owner 10-19)。 */
    autoUpdate?: { on: boolean; onToggle: (on: boolean) => void };
    onUninstall?: () => void;
  };
}) {
  const { manifest, installed, cloud } = subject;
  const activeVariant = variants?.variants.find((variant) => variant.name === variants.active);
  // 没点过切换就跟界面语言(界面语言换了也跟着换);点过的那一格还在就用它。
  const languages = manifestLanguages(manifest, locale);
  const [picked, setPicked] = useState<string | null>(null);
  const textLocale = languages.find((option) => option.locale === picked)?.locale ?? languages[0]!.locale;
  const text = localizedManifestText(manifest, textLocale);
  const compat = cloud?.compat ?? null;
  const deprecated = cloud?.deprecated ?? null;
  const [readme, setReadme] = useState<Loadable<string | null>>({ status: 'idle' });
  const [history, setHistory] = useState<Loadable<MarketVersionHistoryEntry[]>>({ status: 'idle' });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  // 懒加载,换了 App(id / 版本变了)才取一次;卸下时取消挂起的那次,免得旧数据落进新的一页。README 由那台机器答:
  // 装着这一版就读装好的那份(文件夹装的也有,#6950),没装才问市场;没有云端记录的版本历史是空的 —— 空态本身就是正确的画法。
  useEffect(() => {
    let cancelled = false;
    setReadme({ status: 'loading' });
    void api
      .marketReadme({ extensionId: manifest.id, version: manifest.version })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) throw new Error(result.error ?? 'readme unreadable');
        setReadme({ status: 'ready', data: result.data.readme });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn('extension README unreadable:', error);
        setReadme({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, manifest.id, manifest.version]);

  useEffect(() => {
    let cancelled = false;
    setHistory({ status: 'loading' });
    void api
      .marketHistory({ extensionId: manifest.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) throw new Error(result.error ?? 'history unreadable');
        setHistory({ status: 'ready', data: result.data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn('extension version history unreadable:', error);
        setHistory({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, manifest.id]);

  // 给 agent 的工具:装着、启用、没收回那一项的,问它的程序要清单(照 Claude 连接器目录列出来)。
  const toolsOwner = installed && enabled && givesAgentTools(installed) && !revoked.includes('agents:tools') ? installed : null;
  const [tools, setTools] = useState<Loadable<{ name: string; about: string | null }[] | null>>({ status: 'idle' });
  // The tools switch's words are its <label> (`for` = the switch); the ⓘ sits beside them, outside, so the switch's
  // name is the words alone and a click on the ⓘ is never a click on the switch.
  const disclosureSwitchId = useId();
  useEffect(() => {
    if (!toolsOwner || !api.agentTools) {
      setTools({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setTools({ status: 'loading' });
    void api
      .agentTools({ extensionId: toolsOwner.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error ?? 'tools unreadable');
        setTools({ status: 'ready', data: result.data ?? null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn('App agent tools unreadable:', error);
        setTools({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, toolsOwner?.id, toolsOwner?.version]);

  const shownVersion = installed?.version ?? manifest.version;
  const historyEntry = history.status === 'ready' ? history.data.find((entry) => entry.version === shownVersion) : undefined;
  const cloudIsShown = cloud?.version === shownVersion;
  const publishedAt = historyEntry?.publishedAt ?? (cloudIsShown ? cloud?.publishedAt : undefined);
  const permissions = declaredPermissions(installed ?? manifest);
  const withdrawn = permissions.filter((permission) => revoked.includes(permission.key)).length;
  const readmeParts = readme.status === 'ready' && readme.data ? splitReadme(readme.data) : null;
  const shots = readmeParts?.images ?? [];
  const official = Boolean(cloud);
  const publisher = official ? translate('extensions.official') : (manifest.author ?? translate('extensions.publisherLocal'));
  const category = marketCategoryOf(manifest);
  // 装着的看装着的那一版:它和市场上那版带的程序可以不一样,开关、给哪些 agent 管的是装着的这一份。
  const declaring = installed ?? manifest;
  const programs = (declaring.contributes.mcpServers ?? []).map((server) => ('name' in server ? server.name : server.tools));

  // ── 截图一排(照 Google Play:产品页头下面一排图,放不下就横着翻)──
  const screenshots =
    shots.length > 0 ? (
      <section className="mk-dsec is-shots" key="shots" data-testid="app-product-preview">
        <AppShelfRow label={translate('extensions.preview')} prevLabel={translate('extensions.shelfPrev')} nextLabel={translate('extensions.shelfNext')}>
          {shots.map((shot) => (
            <figure className="mk-shot" role="listitem" key={shot.src}>
              {/* README 里的图片是发布时一起传到下载站的公开地址(sync.mjs 改写过);会话页主渲染进程没对 img-src 设 CSP。 */}
              <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
              {/* 图注只在它说了名字以外的话时才写:README 里多半就是 App 的名字,再写一遍是废字。 */}
              {shot.alt && shot.alt !== text.name ? <figcaption>{shot.alt}</figcaption> : null}
            </figure>
          ))}
        </AppShelfRow>
      </section>
    ) : null;

  // ── 对 agent 说:点一句 = 新建任务、这句已填好 ──
  const ask =
    text.examples.length > 0 ? (
      <section className="mk-dsec" key="ask" data-testid="app-product-ask">
        <h3>{translate('extensions.askAgent')}</h3>
        <div className="mk-asks">
          {text.examples.map((example) => (
            <button
              type="button"
              className="mk-ask"
              key={example}
              disabled={!onAsk}
              title={translate('extensions.askAgentHint')}
              onClick={() => onAsk?.(example)}
            >
              <span>{example}</span>
              <ArrowUp className="size-3.5" />
            </button>
          ))}
        </div>
      </section>
    ) : null;

  // ── 关于此 App:这个语言的简介整句(manifest 写的,≤280 字);README 全文在 → 打开的框里(照 Google Play「关于此应用 →」)──
  const readmeText = readmeParts?.text.trim() ?? '';
  const about = (
    <section className="mk-dsec" key="about" data-testid="app-product-about">
      <div className="mk-sec-h">
        <button type="button" className="mk-dsec-link" onClick={() => setAboutOpen(true)} data-testid="app-product-about-open">
          <h3>{translate('extensions.aboutApp')}</h3>
          <ArrowRight className="size-4" />
        </button>
        {languages.length > 1 ? (
          <ToggleGroup
            size="sm"
            spacing={1}
            className="gap-1 overflow-visible border-none bg-transparent"
            aria-label={translate('extensions.textLanguage')}
            value={[textLocale]}
            onValueChange={([value]) => value && setPicked(value)}
            data-testid="app-product-language"
          >
            {languages.map((option) => (
              <ToggleGroupItem key={option.locale} value={option.locale} className="px-2 text-sm">
                {option.language ? languageName(option.language) : translate('extensions.languageOriginal')}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>
      <p className="mk-about">{text.description ?? translate('extensions.noDescription')}</p>
    </section>
  );

  // ── 新功能 + 版本历史 ──
  let news: ReactNode = null;
  if (cloud?.releaseNotes || (history.status === 'ready' && history.data.length > 0)) {
    const latest = history.status === 'ready' ? history.data[0] : undefined;
    const notes = cloud?.releaseNotes ?? latest?.releaseNotes ?? '';
    const notesVersion = cloud?.version ?? latest?.version ?? manifest.version;
    const notesDate = cloud?.publishedAt ?? latest?.publishedAt;
    news = (
      <section className="mk-dsec" key="news" data-testid="app-product-news">
        <div className="mk-sec-h">
          <h3>{translate('extensions.whatsNew')}</h3>
          <button type="button" className="mk-link" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            {translate(historyOpen ? 'extensions.collapse' : 'extensions.detailVersionHistory')}
          </button>
        </div>
        {installed && menu.autoUpdate && !menu.autoUpdate.on ? (
          // 停在人自己挑的那一版(装了旧版,或关了自动更新):说一句,和把它打开回来的那一下(VS Code 勾回「Auto Update」即解钉)。
          <p className="mk-pinned" data-testid="app-product-pinned">
            {translate('extensions.pinnedAt', { version: installed.version })}
            {' · '}
            <button type="button" className="mk-link" disabled={readOnly} onClick={() => menu.autoUpdate?.onToggle(true)}>
              {translate('extensions.autoUpdateResume')}
            </button>
          </p>
        ) : null}
        <div className="mk-new">
          {notes ? <MarkdownRenderer content={notes} onOpenLink={(url) => { onOpenExternal(url); return true; }} /> : null}
          <span>
            {notesDate
              ? translate('extensions.releasedOn', { version: notesVersion, date: shortDate(notesDate, locale) })
              : `v${notesVersion}`}
          </span>
        </div>
        {historyOpen ? (
          // 装某一版是动作:那台机器做不了事时跟头上那颗一起灰。
          <fieldset disabled={readOnly} className="contents">
            <div className="mk-vers">
              <VersionHistorySection
                state={history}
                extensionId={manifest.id}
                installedVersion={installed?.version}
                offeredVersion={installed && menu.autoUpdate?.on ? (cloud?.version ?? null) : null}
                locale={locale}
                translate={translate}
                onOpenExternal={onOpenExternal}
                onInstallVersion={(version) => onInstallVersion({ extensionId: manifest.id, version })}
              />
            </div>
          </fieldset>
        ) : null}
      </section>
    );
  }

  // ── 装上后多了什么 ──
  // 同名的几个页签(会话页一个、群里一个)是用的人眼里的同一个页签:一行,各说各的。
  const tabsByTitle = new Map<string, string[]>();
  for (const tab of manifest.contributes.tabs) {
    const toolbar = (tab.toolbar ?? []).map((command) => command.title);
    const suffixes = [...new Set([...claimedSuffixes(tab, 'session'), ...claimedSuffixes(tab, 'chat')])];
    const line = toolbar.length
      ? translate('extensions.addsTabToolbar', { commands: listOf(toolbar, locale) })
      : suffixes.length
        ? translate('extensions.addsTabOpens', { suffixes: listOf(suffixes, locale) })
        : translate('extensions.addsTabPlain');
    tabsByTitle.set(tab.title, [...(tabsByTitle.get(tab.title) ?? []), line]);
  }
  const adds: ReactNode[] = [...tabsByTitle].map(([title, lines]) => (
    <AddsEntry key={`tab:${title}`} icon={<LayoutGrid className="size-4" />} label={translate('extensions.addsTabTitle', { title })}>
      {[...new Set(lines)].map((line) => (
        <i key={line}>{line}</i>
      ))}
    </AddsEntry>
  ));
  // 给 agent 东西的(带程序,或只带技能说明)都有这一行:「给哪些 agent」和那个开关在这里,❌ 只带技能说明的就够不着。
  if (givesAgentTools(declaring)) {
    adds.push(
      <AddsEntry key="tools" icon={<Wrench className="size-4" />} label={translate('extensions.addsTools')} testId="app-product-tools">
          {tools.status === 'ready' && tools.data && tools.data.length > 0 ? (
            <span className="mk-tools">
              {tools.data.map((tool) => (
                <span className="contents" key={tool.name}>
                  <code title={tool.about ?? undefined}>{tool.name}</code>
                  <i>{tool.about ?? ''}</i>
                </span>
              ))}
            </span>
          ) : (
            <i>
              {tools.status === 'loading'
                ? translate('extensions.inspecting')
                : programs.length === 0
                  ? translate('extensions.addsToolsSkillsOnly')
                  : translate(installed ? 'extensions.addsToolsWhenOn' : 'extensions.addsToolsAfterInstall', {
                      programs: listOf(programs, locale),
                    })}
            </i>
          )}
          {/* 带程序又带技能说明的:说明那一句跟在工具后面,❌ 再单起一行「技能说明」。 */}
          {programs.length > 0 && declaring.contributes.skills ? <i>{translate('extensions.addsSkillsText')}</i> : null}
          {agentStatus?.lastFailure ? (
            // 程序在 stderr 上的原话可能是一整段栈,不进文案(仓规 copy-leaks-internal-detail),放在悬停里。
            <i className="text-foreground-destructive" title={agentStatus.lastFailure.stderrTail || undefined}>
              {programFailureText(agentStatus.lastFailure, translate)}
            </i>
          ) : null}
          {installed && disclosure && onDisclosureChange ? (
            <div className="mk-switch-line">
              {/* owner 10-14:关着的 App 工具 agent 照样用得上(去工具目录里找),那一句放在 ⓘ 里。 */}
              <span className="inline-flex items-center gap-1">
                <label htmlFor={disclosureSwitchId}>{translate('extensions.fullDisclosureToggle')}</label>
                <InfoTooltip label={translate('extensions.fullDisclosureInfoLabel')} content={translate('extensions.fullDisclosureInfo')} />
              </span>
              <Switch
                id={disclosureSwitchId}
                size="sm"
                checked={disclosure === 'full'}
                disabled={readOnly || pending !== undefined}
                aria-label={translate('extensions.fullDisclosureToggle')}
                onCheckedChange={(full) => onDisclosureChange(full ? 'full' : 'progressive')}
              />
            </div>
          ) : null}
          {installed && givenApi && givesAgentTools(installed) ? <AppGivenSection extensionId={installed.id} api={givenApi} machineName={machine} /> : null}
      </AddsEntry>
    );
  }
  if (manifest.permissions?.capabilities?.includes('notifications')) {
    adds.push(
      <AddsEntry key="notify" icon={<Bell className="size-4" />} label={translate('extensions.addsNotify')}>
        <i>{translate('extensions.addsNotifyText')}</i>
      </AddsEntry>
    );
  }
  if (manifest.background && backgroundSupported) {
    adds.push(
      <AddsEntry key="background" icon={<Moon className="size-4" />} label={translate('extensions.addsBackground')}>
        <i>{translate('extensions.permissionsBackground')}</i>
      </AddsEntry>
    );
  }
  const addsSection = (
    <section className="mk-dsec" key="adds" data-testid="app-product-adds">
      <h3>{translate('extensions.whatItAdds')}</h3>
      {/* 一项一行,左边图标,右边名目和一句话;不套框 —— 整页唯一的框留给权限。 */}
      <fieldset disabled={readOnly} className="contents">
        <div className="mk-adds">{adds}</div>
      </fieldset>
    </section>
  );

  // ── 权限:它能看 / 它能做 ──
  const see = permissions.filter((permission) => permissionSide(permission) === 'see');
  const act = permissions.filter((permission) => permissionSide(permission) === 'do');
  const permissionGroup = (side: 'see' | 'do', list: DeclaredPermission[]) =>
    list.length === 0 ? null : (
      <div key={side}>
        <span className="mk-perm-k">{translate(side === 'see' ? 'extensions.permissionsSee' : 'extensions.permissionsDo')}</span>
        {list.map((permission) => {
          const off = revoked.includes(permission.key);
          const commands = permission.kind === 'capability' && permission.key === 'agents:tools' ? programDetails(manifest, translate) : undefined;
          return (
            <div className={cn('mk-pl', off && 'is-revoked')} key={permission.key} data-testid={`app-permission-${permission.key}`}>
              <PermissionIcon permission={permission} side={side} />
              <span>
                {permission.kind === 'network'
                  ? translate('extensions.permissionsNetwork', { hosts: permission.host })
                  : describeCapability(permission.key, installed ?? manifest, translate, machine)}
                {commands ? <pre>{`${commands.caption}\n${commands.lines.join('\n')}`}</pre> : null}
              </span>
              {installed && onTogglePermission ? (
                <button
                  type="button"
                  className="mk-link"
                  disabled={readOnly || pending !== undefined || pendingPermissions.includes(permission.key)}
                  onClick={() => onTogglePermission(permission.key, off)}
                >
                  {translate(off ? 'extensions.restore' : 'extensions.revoke')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  // 照 Google Play「数据安全」:先一句话,再一张带框的卡片(它这一节本来就画框,是整页唯一一张)。
  const permissionsSection = (
    <section className="mk-dsec" key="permissions" data-testid="app-product-permissions">
      <h3 className="flex items-center gap-1">
        {translate('extensions.detailPermissions')}
        {phoneAgentCapabilities.length > 0 ? <InfoTooltip label={translate('extensions.phoneAgentCapabilitiesLabel')} content={<>
          <p>{translate('extensions.phoneAgentCapabilitiesInfo')}</p>
          <ul className="list-disc pl-4">{phoneAgentCapabilities.map((capability) => <li key={capability}>{describeCapability(capability, declaring, translate, machine)}</li>)}</ul>
        </>} /> : null}
      </h3>
      <p className="mk-note">
        {installed && withdrawn > 0
          ? translate('extensions.permissionsWithdrawnNote', { count: permissions.length, revoked: withdrawn })
          : translate(permissions.length === 0 ? 'extensions.permissionsNoteNone' : permissionRevocationSupported ? 'extensions.permissionsNoteAsked' : 'extensions.permissionsNoteInstall')}
      </p>
      <fieldset disabled={readOnly} className="contents">
        <div className="mk-card">
          {permissions.length === 0 ? (
            <div className="mk-pl">
              <Lock className="size-4" />
              <span>{translate('extensions.permissionsNone')}</span>
            </div>
          ) : (
            <>
              {permissionGroup('see', see)}
              {permissionGroup('do', act)}
            </>
          )}
        </div>
      </fieldset>
    </section>
  );

  // ── 右边一栏:审核那张卡(照 Google Play 的「内容分级」卡)、链接、类似 App ──
  const links = [
    manifest.homepage && { label: translate('extensions.linkHomepage'), href: manifest.homepage },
    manifest.repository && { label: translate('extensions.linkRepository'), href: manifest.repository },
  ].filter((entry): entry is { label: string; href: string } => Boolean(entry));
  const sourceButton =
    official && cloud?.source ? (
      // 市场记下的出包来源(仓 @ 提交 @ 目录,App 市场方案 10-07):打出这份字节的那份代码。早于这条记录的版本没有。
      <button type="button" className="mk-ext" title={marketSourceLabel(cloud.source)} onClick={() => cloud.source && onOpenExternal(marketSourceUrl(cloud.source))}>
        {translate('extensions.viewSource')}
        <ExternalLink className="size-3" />
      </button>
    ) : null;
  const side = (
    <aside className="mk-dside">
      <div className="mk-card mk-review" data-testid="app-product-review">
        {official && cloud ? <ShieldCheck className="size-6" /> : <Shield className="size-6" />}
        <div>
          <b>{official && cloud ? translate('extensions.infoReviewed', { version: cloud.version }) : translate('extensions.notReviewed')}</b>
          <span className="mk-review-k">{sourceButton ?? publisher}</span>
        </div>
      </div>
      {links.length > 0 || manifest.license ? (
        <section className="mk-dsec is-side">
          <h3>{translate('extensions.detailLinks')}</h3>
          <div className="mk-side-links">
            {links.map((link) => (
              <button type="button" className="mk-ext" key={link.href} onClick={() => onOpenExternal(link.href)}>
                {link.label}
                <ExternalLink className="size-3" />
              </button>
            ))}
            {manifest.license ? (
              <span className="mk-note">
                {translate('extensions.infoLicense')} {manifest.license}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
      {similar.length > 0 ? (
        <section className="mk-dsec is-side" data-testid="app-product-similar">
          <h3>{translate('extensions.similarApps')}</h3>
          <div className="mk-similar">
            {similar.map((app) => (
              <button type="button" className="mk-similar-row" key={app.id} onClick={app.onOpen} data-testid={`app-product-similar-${app.id}`}>
                <span className="mk-icon is-56">
                  <ExtensionMonogram name={app.name} iconDataUrl={app.iconUrl} />
                </span>
                <span className="mk-similar-tx">
                  <b>{app.name}</b>
                  <span>{app.publisher}</span>
                  <i>{app.line}</i>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );

  // ── 头上一排要点:数在上、名目在下,格子之间一根短竖线(照 Google Play)──
  const size = cloudIsShown && cloud ? formatSize(cloud.bundleBytes) : null;
  const minApp = (cloudIsShown ? cloud?.minAppVersion : undefined) ?? engineFloor(installed ?? manifest);
  const permissionCount =
    permissions.length === 0
      ? translate('extensions.stripPermissionsNone')
      : translate('extensions.stripPermissionsCount', { count: permissions.length });
  const facts: { value: string; caption: string }[] = [
    { value: `v${shownVersion}`, caption: translate('extensions.stripVersion') },
    ...(publishedAt ? [{ value: shortDate(publishedAt, locale), caption: translate('extensions.factUpdated') }] : []),
    ...(size ? [{ value: size, caption: translate('extensions.stripSize') }] : []),
    { value: permissionCount, caption: translate('extensions.detailPermissions') },
    // App Store 产品页头上那一排同样有类别。
    { value: translate(`extensions.category.${category}`), caption: translate('extensions.infoCategory') },
  ];
  // 信息表:正文最后一节,平铺在页上(照 App Store 产品页的「信息」),❌ 收进弹框里。
  const info: [string, ReactNode][] = [
    [translate('extensions.stripVersion'), `v${shownVersion}`],
    ...(declaring.platforms?.length ? ([[translate('extensions.infoPlatforms'), listOf(declaring.platforms.map((platform) => translate(`extensions.platform.${platform}`)), locale)]] as [string, ReactNode][]) : []),
    ...(publishedAt ? ([[translate('extensions.updatedOn'), longDate(publishedAt, locale)]] as [string, ReactNode][]) : []),
    ...(minApp ? ([[translate('extensions.stripNeedsApp'), translate('extensions.stripAndUp', { version: minApp })]] as [string, ReactNode][]) : []),
    ...(size ? ([[translate('extensions.stripSize'), size]] as [string, ReactNode][]) : []),
    [translate('extensions.detailPermissions'), permissionCount],
    [translate('extensions.infoPublisher'), publisher],
    ...(official && cloud ? ([[translate('extensions.infoReview'), translate('extensions.infoReviewed', { version: cloud.version })]] as [string, ReactNode][]) : []),
    [translate('extensions.infoCategory'), translate(`extensions.category.${category}`)],
    ...(manifest.license ? ([[translate('extensions.infoLicense'), manifest.license]] as [string, ReactNode][]) : []),
  ];

  return (
    <div className="mk" data-testid="app-product-page" data-extension-id={manifest.id}>
      {/* 那台机器离线 / server 太旧(#6264):照旧能看(翻截图、看简介、点类似 App),装、卸、收回、装某一版一起灰。 */}
      <button type="button" className="mk-back" onClick={onBack} data-testid="app-product-back">
        <ChevronLeft className="size-3.5" />
        {translate('extensions.title')}
      </button>
      <header className="mk-dh">
        <div className="mk-dh-main">
          <h2 className={cn('gg-type-display mk-dh-title', deprecated && 'is-deprecated')}>{text.name}</h2>
          {text.subtitle ? <p className="mk-dh-sub">{text.subtitle}</p> : null}
          <div className="mk-dh-by">
            <span>{publisher}</span>
          </div>
          <dl className="mk-facts" data-testid="app-product-strip">
            {facts.map((fact) => (
              <div key={fact.caption}>
                <dd>{fact.value}</dd>
                <dt>{fact.caption}</dt>
              </div>
            ))}
          </dl>
          <fieldset disabled={readOnly} className="contents" data-testid="extension-detail-actions">
            <div className="mk-acts" aria-busy={pending ? 'true' : undefined}>
              <AppLifecycleButton
                state={lifecycle}
                pending={pending}
                percent={pendingPercent}
                primary
                disabled={readOnly}
                translate={translate}
                onClick={onLifecycle}
                testId="app-product-action"
              />
              {installed && menu.onForward ? (
                <Button type="button" variant="ghost" size="lg" onClick={menu.onForward} data-testid="app-product-forward">
                  <Share2 className="size-4" />
                  {translate('extensions.forward')}
                </Button>
              ) : null}
              {installed ? (
                <AppMoreMenu
                  name={text.name}
                  enabled={enabled}
                  docked={docked}
                  disabled={readOnly || pending !== undefined}
                  translate={translate}
                  {...menu}
                  // 「转发」已经在外面了(照 Google Play 的「分享」),菜单里不再放一遍。
                  onForward={undefined}
                  testId="app-product-more"
                />
              ) : null}
            </div>
          </fieldset>
        </div>
        <span className="mk-icon is-hero">
          <ExtensionMonogram name={text.name} iconDataUrl={cloud?.iconUrl ?? iconDataUrl} />
        </span>
      </header>

      {justInstalled ? (
        <div className="mk-banner" role="status" data-testid="app-product-installed">
          <Check className="size-3.5" />
          {translate('extensions.justInstalled')}
        </div>
      ) : null}
      {/* 装不上 / 停止维护 / 这一版被撤回:一句话,带它的下一步。 */}
      {compat ? (
        <div className="mk-banner is-warn">
          {compat.reason === 'needs-newer-app'
            ? translate('extensions.needsNewerApp', { version: compat.minAppVersion })
            : translate('extensions.needsAuthorUpdate')}
        </div>
      ) : cloud?.newerNeedsApp ? (
        // 给出的这一版装得了,只是还有更新的一版这台咕咕装不了:说出那一版,❌ 藏起来(market.ts `newerNeedsApp`)。
        <div className="mk-banner" data-testid="app-product-newer-needs-app">
          {translate('extensions.newerNeedsApp', { version: cloud.newerNeedsApp })}
        </div>
      ) : null}
      {installed && notice && notice.kind !== 'update' ? (
        <fieldset disabled={readOnly && notice.kind !== 'forkBehind'} className="contents">
          <div className={cn('mk-banner', notice.kind !== 'forkBehind' && 'is-warn')}>
            <InstalledRowNoticeLine
              notice={notice}
              installedVersion={installed.version}
              translate={translate}
              onInstallVersion={(version) => onInstallVersion({ extensionId: installed.id, version })}
              onBrowseReplacement={() => onBrowseReplacement?.(installed.id)}
              onCopyForkPrompt={notice.kind === 'forkBehind' && activeVariant && onCopyForkPrompt
                ? () => onCopyForkPrompt(activeVariant, notice)
                : undefined}
            />
          </div>
        </fieldset>
      ) : !installed && deprecated ? (
        <div className="mk-banner is-warn">
          {deprecated.replacedBy
            ? translate('extensions.deprecatedRow', { name: deprecated.replacedBy })
            : (deprecated.note ?? translate('extensions.deprecated'))}
        </div>
      ) : null}

      <div className="mk-dbody">
        <div className="mk-dmain">
          {installed && variants && onSwitchVariant && onCopyForkPrompt && (
            <AppVariantList
              active={variants.active}
              variants={variants.variants}
              disabled={readOnly || pending !== undefined}
              translate={translate}
              onSwitch={onSwitchVariant}
              onCopy={onCopyForkPrompt}
            />
          )}
          {screenshots}
          {about}
          {ask}
          {news}
          {addsSection}
          {permissionsSection}
          <section className="mk-dsec" data-testid="app-product-info">
            <h3>{translate('extensions.info')}</h3>
            <dl className="mk-info-grid">
              {info.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        {side}
      </div>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-2xl" data-testid="app-product-about-dialog">
          <DialogHeader>
            <span className="mk-icon is-40">
              <ExtensionMonogram name={text.name} iconDataUrl={cloud?.iconUrl ?? iconDataUrl} />
            </span>
            <span className="mk-dialog-title">
              <DialogTitle>{text.name}</DialogTitle>
              <span>{translate('extensions.aboutApp')}</span>
            </span>
          </DialogHeader>
          <DialogContentArea className="gap-4">
            {readmeText ? <MarkdownRenderer content={readmeText} onOpenLink={(url) => { onOpenExternal(url); return true; }} /> : text.description ? <p>{text.description}</p> : null}
          </DialogContentArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PermissionIcon({ permission, side }: { permission: DeclaredPermission; side: 'see' | 'do' }) {
  // 照原型:看 = 眼睛;做按做的是什么(跑程序 / 替 agent 动手 / 通知 / 替人发话 / 联网),其余一支笔。
  if (side === 'see') return <Eye className="size-4" />;
  if (permission.kind === 'network') return <Globe className="size-4" />;
  if (permission.key === 'agents:tools') return <Terminal className="size-4" />;
  if (permission.key.startsWith('agents:control')) return <Users className="size-4" />;
  if (permission.key === 'notifications') return <Bell className="size-4" />;
  if (permission.key === 'chat:relay') return <MessageCircle className="size-4" />;
  return <Pencil className="size-4" />;
}

/**
 * README 拆成两半:图片(预览那一排用)和其余的字(简介用)。截图放 README 是 owner 09-14 定的(「readme 中放这个插件的截图」),
 * 所以 README 里的图就是这个 App 的截图;字里不再重复画一遍。
 */
export function splitReadme(markdown: string): { images: { src: string; alt: string }[]; text: string } {
  const images: { src: string; alt: string }[] = [];
  const markdownImage = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const htmlImage = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  let text = markdown.replace(markdownImage, (_whole, alt: string, src: string) => {
    images.push({ src, alt: alt.trim() });
    return '';
  });
  text = text.replace(htmlImage, (whole, src: string) => {
    const alt = /\balt=["']([^"']*)["']/i.exec(whole)?.[1] ?? '';
    images.push({ src, alt: alt.trim() });
    return '';
  });
  // 只留绝对地址的图(下载站改写过的都是);别的(相对路径、data:)在这里画不出来。开头那个一级标题就是名字,头上已有。
  return {
    images: images.filter((image) => /^https?:\/\//.test(image.src)),
    text: text.replace(/^\s*#\s+[^\n]*\n/, '').replace(/\n{3,}/g, '\n\n'),
  };
}

/** 「2026年10月8日」:关于此 App 里的更新日期(照 Google Play 写全)。 */
function longDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function shortDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** 一种语言用它自己的名字叫(「中文」「English」),语言切换照惯例都这么写。 */
function languageName(language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** 字节数 → 「640 KB」「2.1 MB」。 */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 几样东西连成一句(「A、B 和 C」/「A, B, and C」),❌ 拿 · 串。 */
export function listOf(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** 「装上后多了什么」那张卡里的一行:左边一个图标,右边名目(粗)和内容。 */
function AddsEntry({ icon, label, testId, children }: { icon: ReactNode; label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="mk-add" data-testid={testId}>
      {icon}
      <div>
        <b>{label}</b>
        {children}
      </div>
    </div>
  );
}

/** manifest 自己写的 `engines.gugu` 下界(`>=0.2.40` / `^0.2.40` → `0.2.40`)。 */
function engineFloor(manifest: ExtensionManifest): string | null {
  return manifest.engines?.gugu.replace(/^(>=|\^)/, '') ?? null;
}

function VersionHistorySection({
  state,
  extensionId,
  installedVersion,
  offeredVersion,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
}: {
  state: Loadable<MarketVersionHistoryEntry[]>;
  extensionId: string;
  installedVersion: string | undefined;
  /** 市场给这台机器的那一版,这个 App 还在自动更新时才给:比它旧的那几版一装上就不再自动更新,按钮上说一句。 */
  offeredVersion: string | null;
  locale: string;
  translate: SessionTranslate;
  onInstallVersion: (version: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return <p className="text-foreground-passive">{translate('extensions.loading')}</p>;
  }
  if (state.status === 'error') {
    return <p className="text-foreground-muted">{translate('extensions.historyUnavailable')}</p>;
  }
  if (state.data.length === 0) {
    return <p className="text-foreground-muted">{translate('extensions.historyNone')}</p>;
  }
  return (
    <ul className="xp-history">
      {state.data.map((entry) => (
        <VersionHistoryRow
          key={entry.version}
          entry={entry}
          extensionId={extensionId}
          installedVersion={installedVersion}
          pins={pinsAutoUpdate(entry.version, offeredVersion)}
          locale={locale}
          translate={translate}
          onInstallVersion={onInstallVersion}
          onOpenExternal={onOpenExternal}
        />
      ))}
    </ul>
  );
}

/**
 * 一版一行:版本 · 日期 · 这版第一句 · 右边一个词。右边那个词:装着的写「装着的这一版」;比装着的新 =「更新」,
 * 旧 =「改用 vX」(原型的版本历史);没装 =「安装」;装不了的写原因;撤回的那版把原因放在句子那一格、右边什么都不放。
 */
function VersionHistoryRow({
  entry,
  extensionId,
  installedVersion,
  pins,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
}: {
  entry: MarketVersionHistoryEntry;
  extensionId: string;
  installedVersion: string | undefined;
  /** 装上它,这个 App 就不再自动更新(`pinsAutoUpdate`)。 */
  pins: boolean;
  locale: string;
  translate: SessionTranslate;
  onInstallVersion: (version: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isInstalled = entry.version === installedVersion;
  const yankedReason = entry.yanked ? translate('extensions.historyYanked', { note: entry.yanked.reason }) : null;
  const compatReason = entry.platformRefusal
    ? translate('extensions.platformVersionUnavailable')
    : entry.compat
    ? entry.compat.reason === 'needs-newer-app'
      ? translate('extensions.needsNewerApp', { version: entry.compat.minAppVersion })
      : translate('extensions.needsAuthorUpdate')
    : null;
  const firstLine = (entry.releaseNotes.split(/\r?\n/).find((line) => line.trim() !== '') ?? '')
    .trim()
    .replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '');
  const actionLabel = !installedVersion
    ? translate('extensions.installAction')
    : compareExtensionVersions(entry.version, installedVersion) > 0
      ? translate('extensions.updateAction')
      : translate('extensions.useVersion', { version: entry.version });

  return (
    <li data-testid={`extension-history-${extensionId}-${entry.version}`}>
      <div className="xp-history-row">
        <span className={cn('xp-history-version', entry.yanked && 'is-yanked')}>{entry.version}</span>
        <span className="xp-history-date">{shortDate(entry.publishedAt, locale)}</span>
        {yankedReason ? (
          <span className="xp-history-note is-warn">{yankedReason}</span>
        ) : (
          <button
            type="button"
            className={cn('xp-history-note', expanded && 'is-open')}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '' : firstLine}
          </button>
        )}
        <span className="xp-history-action">
          {isInstalled ? (
            <span className="xp-state">{translate('extensions.stripThisInstalled')}</span>
          ) : yankedReason ? null : compatReason ? (
            <span className="xp-state">{compatReason}</span>
          ) : (
            <button
              type="button"
              className="xp-link"
              title={pins ? translate('extensions.pinHint') : undefined}
              onClick={() => onInstallVersion(entry.version)}
            >
              {actionLabel}
            </button>
          )}
        </span>
      </div>
      {expanded && !yankedReason ? (
        <div className="xp-history-body">
          <MarkdownRenderer content={entry.releaseNotes} onOpenLink={(url) => { onOpenExternal(url); return true; }} />
        </div>
      ) : null}
    </li>
  );
}
