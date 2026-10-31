import { useAppDetailRequest } from '@renderer/features/apps/use-app-detail-request';
import type { AppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { messageForUser } from '@/lib/userFacingError';
import { CircleAlert, Trash2Icon } from '@/lib/icons';
import { UI_EVENTS } from '@/lib/uiEvents';
import { observer } from 'mobx-react-lite';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { registerInstalledExtensionTabs } from '@renderer/features/extensions/register-extension-tabs';
import { setExtensionEnabled } from '@renderer/features/extensions/set-extension-enabled';
import { openApp, openAppInWindow, pinToDock, unpinFromDock } from '@renderer/features/extensions/app-dock';
import { WORKSPACE_APP_ID, type ExtensionDisclosureLevel } from '@renderer/features/extensions/installed-extensions-store';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { PageHeader } from '@renderer/lib/components/page-header';
import { log } from '@renderer/utils/logger';
import { rpcOn } from '@renderer/lib/ipc';
import { installAgreedOn } from '@shared/extensions/install-agreed-on';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ConsentPrompt } from '@renderer/features/extensions/extension-consent';
import { ConsentBody } from '@/components/extensionBundle/ConsentDetails';
import { askInShell, installConsentPrompt, type InstallConsentAsk } from '@renderer/features/extensions/install-consent';
import { alsoOnMachines, INSTALL_CONSENT_HUMAN_WINDOW_MS, type InstallGrant, type InstallAlsoOnMachine } from '@shared/extensions/host-actions';
import { findRemoteHostsBridge } from '@shared/remote-hosts';
import { installedElsewhere } from '@renderer/features/extensions/installed-elsewhere';
import { AppMarketContent, type AppMarketState } from '@renderer/features/extensions/panel/app-market-content';
import { featuredShotsReady } from '@renderer/features/extensions/panel/app-featured';
import { keepShelf, keptShelf } from '@renderer/features/extensions/panel/kept-shelf';
import { appLifecycle } from '@renderer/features/extensions/panel/app-lifecycle';
import type { AppLifecycle } from '@renderer/features/extensions/panel/app-lifecycle-button';
import { AppProductPage, listOf, type ExtensionDetailSubject } from '@renderer/features/extensions/panel/app-product-page';
import { InstalledAppRow } from '@renderer/features/extensions/panel/app-rows';
import {
  InstalledRowNoticeLine,
  programFailureText,
  type InstalledRowNotice,
} from '@renderer/features/extensions/panel/installed-extension-row';
import type { ExtensionPendingAction } from '@renderer/features/extensions/panel/extension-pending';
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram';
import {
  InstalledRowsSkeleton,
  ShelfSkeleton,
} from '@renderer/features/extensions/panel/extension-skeletons';
import '@renderer/features/extensions/panel/extensions-panel.css';
import '@renderer/features/extensions/panel/app-store.css';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  declaredPermissions,
  INSTALLED_GROUP_ORDER,
  installedGroupOf,
  localizedManifestText,
  marketCategoryOf,
  matchesExtensionQuery,
  type InstalledGroup,
  type InstalledUpdateFlag,
  type MarketCategory,
} from '@shared/extensions/catalog';
import type {
  MarketListItem,
  MarketSourceRef,
} from '@shared/extensions/market';
import { marketDownloadProgressChannel, marketRefreshedChannel } from '@shared/extensions/marketEvents';
import type { MarketRefreshed } from '@shared/extensions/market-snapshot';
import { marketHome } from '@shared/extensions/market-home';
import { chatDb } from '@/lib/supabase';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { readCachedDevices } from '@/store/devicesCache';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

/**
 * 左栏「App」那一页 = App 市场(#7059,照改版原型):整页居中一栏,顶上「App」+ 一句话 + 搜索,下面「市场 / 已安装」。
 * 市场 = 官方精选 + 按类别两列平铺,每行就地一颗按钮;点一行 = 它的产品页(就在这一栏里铺开,❌ 弹框)。
 * 已安装按「需要处理 / 有更新 / 已启用 / 未启用」分组,每行按钮 + 开关 + ⋯。
 * 从市场装走的是与手选文件夹**完全相同**的 `inspect → consent → install`。Refs #2374, #5265, #5410.
 */

/** 清单上的一条:manifest 画卡片,ref 说装的时候装哪一版,cloud 是清单上那一版的其余
 *  (版本、兼容、弃用、图标、更新说明、代码在哪,#5410)。 */
type ShelfItem = MarketListItem;

/**
 * The shelf, as this screen has read it so far. 一页一页取(#5410):`items` 是已经取到的
 * 那几页拼起来的,`total` 是服务端说的总数,`hasMore` 决定底部要不要再取;换搜索词从第 0 页重来。
 */
type ShelfState = AppMarketState;

/** The inventory (what is installed), as this screen has read it so far. */
type InventoryState = 'loading' | 'ready' | 'error';

/**
 * 每台机器的市场那一块,这一页上次画出来的样子(不带搜索词那一份,按 `host.key`):再打开、换机器再换回来,先画它,
 * 同时照常从那台机器手上的目录读一遍、原地换上(owner 10-16「本地有缓存啊」)。重启后的第一帧也是它(kept-shelf.ts)。
 */
const lastShelf = new Map<string, Extract<ShelfState, { status: 'ready' }>>();
type KeptExtra = Pick<Extract<ShelfState, { status: 'ready' }>, 'invalid' | 'total' | 'page'>;

function shelfOf(hostKey: string): Extract<ShelfState, { status: 'ready' }> | undefined {
  const inRun = lastShelf.get(hostKey);
  if (inRun) return inRun;
  const kept = keptShelf<ShelfItem, KeptExtra>(hostKey);
  if (!kept) return undefined;
  const { featured, ...home } = kept.home;
  const shelf = { status: 'ready' as const, query: '', errorKind: null, items: kept.items, hasMore: false, loadingMore: false, featured, home, ...kept.extra };
  lastShelf.set(hostKey, shelf);
  return shelf;
}

/** 「上次更新于」的那个时刻:今天的只写几点几分,不是今天的带上日期。 */
function marketStaleTime(iso: string, locale: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(
    locale,
    today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  ).format(at);
}


const GROUP_LABEL = {
  attention: 'extensions.groupAttention',
  update: 'extensions.groupUpdate',
  active: 'extensions.groupActive',
  disabled: 'extensions.groupDisabled',
} as const satisfies Record<InstalledGroup, string>;

type StoreTab = 'market' | 'newest' | 'popular' | 'all' | 'installed';

export const ExtensionsSettingsCard = observer(function ExtensionsSettingsCard({ detailLink }: { detailLink?: AppDetailLink }) {
  const { translate, locale } = useSessionMessages();
  // #6264 资源库看的是哪台咕咕:本机是全局那份清单与 `rpc.extensions`;另一台咕咕桌面是它自己的那份,
  // 动作经设备 RPC 转到它的主进程,它自己的窗口跟着补上 / 撤下 tab。页面长相不变。
  const library = useLibraryHost();
  const host = library.extensions;
  const store = host.store;
  const api = host.api;
  const queryClient = useQueryClient();
  const remote = library.remote;
  // 看的是另一台机器、它此刻连不上:市场清单问不了(问了只会挂满超时)。
  const machineOffline = Boolean(remote && !remote.online);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  // 别的机器读清单没读到(离线 / server 太旧 / 问不通):页面上说一句人话,❌ 弹一条带原文的失败 toast。
  const [inventoryError, setInventoryError] = useState<unknown>(null);
  const notice = deviceScopeNotice(
    { remote, error: inventoryError, hasData: store.isLoaded, now: Date.now(), cloud: remoteHostsStore.cloudScope(remote?.deviceId) },
    translate
  );
  const showConfirm = useShowModal('confirmActionModal');
  const [isBusy, setIsBusy] = useState(false);
  const { navigate } = useNavigate();
  // 进来先是市场(原型 S.store.tab = 'market');有更新时「已安装」上一个红点。
  const [tab, setTab] = useState<StoreTab>('market');
  const [chip, setChip] = useState<'all' | MarketCategory>('all');
  // 刚在产品页里装好的那一个:那一页头下面说一句「装好了」和去哪找它。
  const [justInstalled, setJustInstalled] = useState<string | null>(null);
  // 进产品页从顶上看起;回清单回到刚才滚到的地方(照 Mac App Store 的返回)。滚的是外面那一层页面。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listScroll = useRef(0);
  const scroller = () => {
    let node = rootRef.current?.parentElement ?? null;
    // 这一页所在那扇窗自己的 getComputedStyle(单独成窗时不是主窗那一个)。
    while (node && !/(auto|scroll)/.test(node.ownerDocument.defaultView?.getComputedStyle(node).overflowY ?? '')) node = node.parentElement;
    return node;
  };
  const [query, setQuery] = useState('');
  // 搜索词打到服务端去,所以敲字要缓一拍 —— 每个字符一趟请求是在替用户刷自己的清单接口。
  const debouncedQuery = useDebounce(query.trim(), 250);
  const [shelf, setShelf] = useState<ShelfState>(() => shelfOf(host.key) ?? { status: 'loading' });
  const shelfRef = useRef(shelf);
  shelfRef.current = shelf;
  // 后台那趟没取到:手上那份照旧画,页头安静写一句「上次更新于 …」(那份的时刻)。❌ 弹错、❌ 错误面板。
  const [marketStale, setMarketStale] = useState<string | null>(null);
  // 页面画着的那份目录是哪一刻的:同一刻的「变了」(推送和 marketRefresh 的回答各报一次)只重读一回。
  const shelfFetchedAt = useRef<string | null>(null);
  const [detail, setDetail] = useState<ExtensionDetailSubject | null>(null);
  // Boot may have filled the store already; then the page opens on that copy and
  // re-reads behind it (stale-while-revalidate) rather than flashing a skeleton
  // over rows it could show.
  const [inventory, setInventory] = useState<InventoryState>(
    store.isLoaded ? 'ready' : 'loading'
  );
  // What is in flight, in two copies: the state is what the screen draws, the
  // ref is what the guards read. A guard on state alone lets a double click
  // through — both clicks land in the same tick, before the first has rendered
  // (the browser test fires consent twice synchronously and got two installs).
  const [pending, setPending] = useState<Record<string, ExtensionPendingAction>>({});
  const inFlight = useRef<Record<string, ExtensionPendingAction>>({});
  const beginPending = (extensionId: string, action: ExtensionPendingAction) => {
    inFlight.current = { ...inFlight.current, [extensionId]: action };
    setPending(inFlight.current);
  };
  const endPending = (extensionId: string) => {
    const { [extensionId]: _done, ...rest } = inFlight.current;
    inFlight.current = rest;
    setPending(rest);
    setDownloadPercent((current) => {
      const { [extensionId]: _dropped, ...restPercent } = current;
      return restPercent;
    });
  };
  // 下载中那个百分比,按 extensionId 存,和 pending 分开放:pending 只是「在忙一件事」
  // 这一个词,percent 只在下载云端包那一段才有意义(#5410)。
  const [downloadPercent, setDownloadPercent] = useState<Record<string, number>>({});
  useEffect(
    () =>
      host.onEvent(marketDownloadProgressChannel, ({ extensionId, received, total }) => {
        // 只更新正在等这个包的那一格:一个先前失败又被别处重试的下载,不该把别的进度条
        // 也拖着走。
        if (!(extensionId in inFlight.current)) return;
        beginPending(extensionId, 'downloading');
        setDownloadPercent((current) => ({
          ...current,
          [extensionId]: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        }));
      }),
    []
  );
  // Permission switches in flight, as `<extensionId>\u0000<permission>`, same shape.
  const [pendingPermissions, setPendingPermissions] = useState<Record<string, true>>({});
  const permissionsInFlight = useRef<Record<string, true>>({});
  // On/off switches in flight, by extension id.
  const [switching, setSwitching] = useState<Record<string, true>>({});

  // Which declared hosts the user has taken back, per extension. Held here
  // rather than in the tab store: it is what this screen manages, and no other
  // surface asks the question.
  const [revoked, setRevoked] = useState<Record<string, string[]>>({});

  // `useSessionMessages` hands back a fresh closure every render, so keying an
  // effect on it turns "read once on mount" into "read on every render" — and
  // since the read writes the observable store this component observes, that is
  // an unbounded loop hammering IPC. Hold the current one in a ref instead and
  // let `refresh` be what it actually is: an action, not a render-derived value.
  const translateRef = useRef(translate);
  translateRef.current = translate;

  // #6387 各扩展给 agent 的程序:几个会话在用、最近一次没起来的原因。随清单一起读。
  const [agentStatus, setAgentStatus] = useState<Record<string, ExtensionAgentStatus>>({});

  const refresh = useCallback(async () => {
    try {
      // Both reads, every time. `refresh` is called precisely at the moments the
      // inventory changed — after an install, after an uninstall — so gating it
      // on `isLoaded` made it a no-op exactly then: on the real machine an
      // uninstalled extension kept its card, with live-looking switches, while
      // `extensions.list` had already dropped it. (The same guard previously
      // skipped the withdrawal read as well, drawing every switch ON while main
      // enforced a host as off.) The screen that manages this inventory reads
      // it; one list call is not worth a stale one.
      await store.load();
      const permissions = await api.revoked();
      // Swallowing this would draw every switch ON while the main process is
      // hard-failing on the same read — the screen would claim a permission is
      // granted that activation refuses to honour.
      if (!permissions.success || !permissions.data) {
        throw new Error(permissions.error ?? 'permissions unreadable');
      }
      setRevoked(permissions.data);
      const agents = await api.agentStatus();
      if (!agents.success || !agents.data) throw new Error(agents.error ?? 'agent status unreadable');
      setAgentStatus(agents.data);
      setInventoryError(null);
      setInventory('ready');
    } catch (error) {
      log.error('extension inventory unreadable:', error);
      if (remoteRef.current) {
        // 别的机器:那一句话在页头(deviceScopeNotice),不弹 toast。
        setInventoryError(error);
        setInventory('error');
        return;
      }
      // The tab shows the failure in place with a way back (below); the toast
      // reaches whoever is on the other tab.
      setInventory('error');
      toast({
        title: translateRef.current('extensions.loadFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translateRef.current('extensions.retry'), onClick: () => void refresh() },
      });
    }
  }, []);

  // The shelf is read separately from the inventory: it does not change when
  // something is installed, and its failure has its own face (an error panel on
  // the market tab) rather than a toast over the whole screen.
  //
  // 分页:`readShelf` 从第 0 页取起(换搜索词、打开、重试都从这儿起),`loadMore` 取下一页拼在后面。
  // 一个自增的序号挡住乱序:慢的旧请求回来时,如果搜索词已经换了,它的结果直接丢掉。
  // 读的是那台机器手上的目录(market-snapshot.ts),❌ 等下载站。同一个搜索词再读一遍(打开时、目录变了、重试)时
  // 画着的那份留着、读回来原地换上 —— ❌ 骨架、❌ 回到顶上;`pages` = 已经翻到的那几页一起重读,下面的不会少掉一截。
  const shelfRequest = useRef(0);
  const readShelf = useCallback(async (search = '', pages = 1) => {
    const ticket = (shelfRequest.current += 1);
    const keeps = (current: ShelfState) => current.status === 'ready' && current.query === search && !current.errorKind;
    const painted = keeps(shelfRef.current);
    setShelf((current) => (keeps(current) ? current : { status: 'loading' }));
    try {
      const ranking = search === ''
        ? Promise.resolve(chatDb.rpc('market_install_ranking')).then(({ data, error }) => {
            if (error) throw error;
            return new Map(((data ?? []) as { app_id: string; score: number }[]).map((row) => [row.app_id, row.score]));
          }).catch((error: unknown) => {
            log.warn('market install ranking unreadable:', error);
            return null;
          })
        : Promise.resolve(new Map<string, number>());
      const [result, scores] = await Promise.all([api.market({ page: 0, query: search }), ranking]);
      if (ticket !== shelfRequest.current) return;
      // The market answers every call (unreachable is `errorKind`); only a call that did not get there lands here.
      if (!result.success || !result.data) throw new Error('market unreadable');
      for (const entry of result.data.invalid) {
        // The reason is for whoever fixes the bundle, not for the person browsing;
        // the row on screen says only that it could not be listed.
        log.warn(`extension catalog: ${entry.dirName} could not be listed: ${entry.reason}`);
      }
      if (result.data.error) {
        // 连不上这件事本身要留痕:界面上有那一句,日志里有原话。
        log.warn(`extension market unreachable: ${result.data.error}`);
      }
      let items = result.data.extensions;
      let last = result.data;
      for (let page = 1; last.hasMore && (search === '' || page < pages); page += 1) {
        const next = await api.market({ page, query: search });
        if (ticket !== shelfRequest.current) return;
        // 推荐与完整排序页必须读齐;搜索保留分页重试。
        if (!next.success || !next.data || next.data.errorKind) {
          if (search === '') throw new Error('The complete market catalog could not be read');
          break;
        }
        const seen = new Set(items.map((item) => item.manifest.id));
        items = [...items, ...next.data.extensions.filter((item) => !seen.has(item.manifest.id))];
        last = next.data;
      }
      const { featured, ...home } = marketHome(items.map((item) => ({ ...item, ...item.cloud })), scores);
      // 画着一份时,新的那份等精选底图解码好再整份换上;取不到就留着画着的那份(下面 catch)。第一次读不等:没有可留的,卡片自己取。
      if (painted) await featuredShotsReady(queryClient, api, host.key, featured);
      if (ticket !== shelfRequest.current) return;
      shelfFetchedAt.current = result.data.fetchedAt;
      const ready: Extract<ShelfState, { status: 'ready' }> = {
        status: 'ready',
        query: search,
        errorKind: result.data.errorKind,
        items,
        invalid: result.data.invalid,
        total: last.total,
        page: last.page,
        hasMore: last.hasMore,
        featured,
        home,
        loadingMore: false,
      };
      setShelf(ready);
      // 下次打开先画这份完整目录与编排。
      if (search === '' && !ready.errorKind) {
        lastShelf.set(host.key, ready);
        keepShelf<ShelfItem, KeptExtra>(host.key, items, { featured, ...home }, { invalid: ready.invalid, total: ready.total, page: ready.page });
      }
    } catch (error) {
      if (ticket !== shelfRequest.current) return;
      // Not an empty shelf. A missing or unreadable catalog is a packaging
      // fault: the tab says so, and the path goes to the log. 画着同一个词的那份时照旧画它(重读没读到,不是读不到)。
      log.error('extension catalog unreadable:', error);
      setShelf((current) =>
        current.status === 'ready' && current.query === search && !current.errorKind ? current : { status: 'error' }
      );
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (shelf.status !== 'ready' || !shelf.hasMore || shelf.loadingMore) return;
    const ticket = shelfRequest.current;
    const nextPage = shelf.page + 1;
    setShelf({ ...shelf, loadingMore: true });
    try {
      const result = await api.market({ page: nextPage, query: debouncedQuery });
      if (ticket !== shelfRequest.current) return;
      // The market answers every call (unreachable is `errorKind`); only a call that did not get there lands here.
      if (!result.success || !result.data) throw new Error('market unreadable');
      const data = result.data;
      setShelf((current) => {
        if (current.status !== 'ready') return current;
        // 同一个 id 不画两次:两页之间清单若被改动(发布了新扩展),边界会挪一格。
        const seen = new Set(current.items.map((item) => item.manifest.id));
        return {
          ...current,
          items: [...current.items, ...data.extensions.filter((item) => !seen.has(item.manifest.id))],
          total: data.total,
          page: data.page,
          hasMore: data.hasMore,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (ticket !== shelfRequest.current) return;
      // 下一页没取到:已经画出来的留着,底部的「加载更多」还在,用户可以再点。
      log.warn('extension catalog next page unreadable:', error);
      setShelf((current) => (current.status === 'ready' ? { ...current, loadingMore: false } : current));
    }
  }, [shelf, debouncedQuery]);

  // 底部哨兵:滚到它就取下一页 —— 往下滚本身就是「我还要看」,❌ 不再要一次点击
  // (owner 2026-09-14:「我不要手动点才能加载更多,下滚不就可以加载更多了吗」)。
  // 翻页看不看得见,靠的是一页只放 12 张、底下写着取到第几条,不是靠一个按钮。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const canLoadMore = shelf.status === 'ready' && shelf.hasMore && !shelf.loadingMore;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  // 产品页铺开时整个清单卸掉、页脚那一行跟着没了;回来以后是新的一行,要重新盯上(`detail` 进依赖)。
  }, [canLoadMore, tab, detail]);

  const detailId = detail?.manifest.id ?? null;
  useLayoutEffect(() => {
    const page = scroller();
    if (page) page.scrollTop = detailId ? 0 : listScroll.current;
  }, [detailId]);

  /**
   * 一个扩展当前在市场上的那一版:先看已经取到的页,没有就定点问一次。
   * 清单是分页的,装着的那个未必在已取到的页里;连不上就 undefined。
   */
  const shelfItemFor = useCallback(
    async (extensionId: string): Promise<ShelfItem | undefined> => {
      const loaded =
        shelf.status === 'ready' ? shelf.items.find((item) => item.manifest.id === extensionId) : undefined;
      if (loaded) return loaded;
      const result = await api.marketEntry({ extensionId }).catch(() => null);
      return result?.success && result.data ? result.data : undefined;
    },
    [shelf]
  );

  // 下载站那一趟回来了(打开这一页时去的那趟,或者别处 —— 启动、安装 —— 去的):变了,市场这一块和「有新版 / 被撤回」
  // 一起从新的那份重读(两边永远是同一刻,10-08 的一致性);没变什么都不重画;没取到,照旧画手上那份、页头写「上次更新于 …」。
  const debouncedQueryRef = useRef(debouncedQuery);
  debouncedQueryRef.current = debouncedQuery;
  const onMarketRefreshed = (refreshed: MarketRefreshed) => {
    if (refreshed.outcome === 'failed') {
      setMarketStale(refreshed.fetchedAt);
      return;
    }
    setMarketStale(null);
    if (refreshed.outcome !== 'changed' || refreshed.fetchedAt === shelfFetchedAt.current) return;
    shelfFetchedAt.current = refreshed.fetchedAt;
    const current = shelfRef.current;
    void readShelf(debouncedQueryRef.current, current.status === 'ready' ? current.page + 1 : 1);
    // 本机那份「有新版」由 wireMarketRefresh 跟着推送重查;别的机器的推送未必转得过来,这里查。
    if (!host.local) void store.checkUpdates();
  };
  const onMarketRefreshedRef = useRef(onMarketRefreshed);
  onMarketRefreshedRef.current = onMarketRefreshed;
  useEffect(() => host.onEvent(marketRefreshedChannel, (refreshed) => onMarketRefreshedRef.current(refreshed)), []);

  useEffect(() => {
    // 那台机器离线:一问都不发(问不到只会挂满超时),照旧画上次读到的那份、只读。
    if (remote && !remote.online) return;
    void refresh();
    // 打开设置页时也查一次「有什么要告诉你的」(spec:启动时一次、打开设置页时一次,
    // ❌ 轮询)。embedded.tsx 已经在启动时查过一次;这里是「打开设置页时」那一次。
    void store.checkUpdates();
    // 这一次和下面的市场清单都先从那台机器手上的目录答(❌ 等下载站);同时让它去下载站取一趟,回来的结果走
    // onMarketRefreshed。结果用回答带回:别的机器的推送未必转得到这个窗口。比这一版旧的机器没有这一问,照旧现取。
    void api
      .marketRefresh()
      .then((result) => {
        if (result.success && result.data) onMarketRefreshedRef.current(result.data);
      })
      .catch((error: unknown) => log.warn('App market refresh not asked:', error));
  }, [refresh]);

  // 首次与每次搜索词变化:从第 0 页重来。读的是手上那份目录,和上面那趟更新检查同一份;
  // 下载站那趟取回来变了,两边由 onMarketRefreshed 一起重读。
  useEffect(() => {
    if (remote && !remote.online) return;
    void readShelf(debouncedQuery);
  }, [readShelf, debouncedQuery, remote?.online]);

  /**
   * 从市场装:装法只有一条 —— main 的 installExtensionFromMarket(群里的「用 X 打开」、首启那一页、agent 的 app_install 走的
   * 也是它,161 10-15)。main 下载、比对指纹、解包、读 manifest,把要问的交回来(`consent: return`);这个窗口问(另一台
   * 机器的 App 也在这里问),点了头再带着指纹去装(`given`,用的就是刚才那一份,不再下一遍)。下载进度照旧推给卡片。
   *
   * ⚠️ 用户点头的是「这个包声明了什么」:main 读的是解开的那一份 manifest,不是清单上那张卡片写的。
   */
  const installFromShelf = useCallback(
    async (ref: MarketSourceRef, extensionId?: string) => {
      if (extensionId) {
        if (inFlight.current[extensionId]) return;
        beginPending(extensionId, 'inspecting');
      }
      try {
        const handed = await api.installFromMarket({ ref, consent: { kind: 'return' } });
        if (!handed.success || !handed.data) throw new Error(handed.error ?? '');
        if (handed.data.outcome !== 'ask') return;
        const { ask, asks } = handed.data;
        // 第一次装、什么都不要的,以及同来源、不多要权限的更新:点「安装」本身就是同意(main 的 installPlan 判的,
        // #7059 原型「什么权限都不要的直接装」)。
        if (!asks) {
          if (extensionId) endPending(extensionId);
          await completeMarketInstall(ask);
          return;
        }
        // Installing on another machine: the sheet names it, every sentence (main there does not know it is asked from here).
        const machine = remoteRef.current?.deviceLabel;
        const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
        // owner 10-16「装的时候一次选好装到哪几台」: the person's other online computers, each by name, ticked in the same sheet.
        const alsoOn = alsoOnMachines(findRemoteHostsBridge()?.listDevices() ?? [], remoteRef.current?.deviceId);
        await askToInstall(prompt, ask.manifestDigest, ask.given, async (also) => {
          await completeMarketInstall(ask);
          for (const deviceId of also ?? []) await installOnAlso(deviceId, alsoOn.find((one) => one.id === deviceId)?.label ?? deviceId, ask);
        }, machine, alsoOn);
      } catch (error) {
        log.error('extension market install failed:', error);
        toast({
          title: translateRef.current('extensions.installFailed'),
          description: messageForUser(error),
          tier: 'error',
          action: {
            label: translateRef.current('extensions.retry'),
            onClick: () => void installFromShelf(ref, extensionId),
          },
        });
      } finally {
        if (extensionId) endPending(extensionId);
      }
    },
    [showConfirm]
  );

  /**
   * Read the manifest first and show what it asks for. Consent comes before the
   * bundle is installed, not after. `extensionId` is known when the call is a retry
   * from a card, and is what lets that card say "reading…" and refuse a second
   * click; the folder picker has no id until the read returns, so the toolbar
   * button carries its own busy flag instead.
   */
  const installFromDirectory = useCallback(
    async (sourceDir: string, extensionId?: string) => {
      if (extensionId) {
        if (inFlight.current[extensionId]) return;
        beginPending(extensionId, 'inspecting');
      }
      try {
        // The one way every install goes (main's install-prepared.ts): what it would ask, handed back — or nothing to ask,
        // and the click was the yes. The digest travels with the consent: the install refuses if the folder no longer
        // matches what the sheet was read from.
        const handed = await api.installFromFolder({ sourceDir, consent: { kind: 'return' } });
        if (!handed.success || !handed.data) throw new Error(handed.error ?? translateRef.current('extensions.manifestUnreadable'));
        if (handed.data.outcome !== 'ask') return;
        const { ask, asks } = handed.data;
        if (!asks) {
          await completeInstall(sourceDir, ask);
          return;
        }
        const machine = remoteRef.current?.deviceLabel;
        const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
        // owner 10-16 / 09-25「完整能力披露」: the other computers are listed and greyed — a folder is only this computer's to read.
        const alsoOn = alsoOnMachines(findRemoteHostsBridge()?.listDevices() ?? [], remoteRef.current?.deviceId, translateRef.current('extensions.alsoOnFolderOnly'));
        await askToInstall(prompt, ask.manifestDigest, ask.given, () => completeInstall(sourceDir, ask), machine, alsoOn);
      } catch (error) {
        toast({
          title: translateRef.current('extensions.installFailed'),
          description: messageForUser(error),
          tier: 'error',
          action: {
            label: translateRef.current('extensions.retry'),
            onClick: () => void installFromDirectory(sourceDir, extensionId),
          },
        });
      } finally {
        if (extensionId) endPending(extensionId);
      }
    },
    [showConfirm]
  );

  const switchVariant = async (manifest: ExtensionManifest, name: string) => {
    if (inFlight.current[manifest.id]) return;
    beginPending(manifest.id, 'inspecting');
    try {
      const handed = await api.switchVariant(manifest.id, name, { kind: 'return' });
      if (!handed.success || !handed.data) throw new Error(handed.error ?? 'App variant unreadable');
      if (handed.data.outcome !== 'ask') { await refresh(); return; }
      const { ask, asks } = handed.data;
      const complete = () => installing(
        ask.manifest,
        () => api.switchVariant(manifest.id, name, { kind: 'given', digest: ask.manifestDigest }),
        () => switchVariant(manifest, name),
      );
      if (!asks) { await complete(); return; }
      const machine = remoteRef.current?.deviceLabel;
      const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
      await askToInstall(prompt, ask.manifestDigest, ask.given, complete, machine);
    } catch (error) {
      toast({ title: translateRef.current('extensions.switchFailed'), description: messageForUser(error), tier: 'error' });
    } finally {
      endPending(manifest.id);
    }
  };

  /**
   * One way to ask, for every install here: with 「给哪些 agent」 (D-30) in the shell's sheet, else in the session page's own
   * dialog. `agreed` runs on a yes; this resolves once the shell's sheet is answered (the dialog answers on its own).
   */
  const askToInstall = async (
    prompt: ConsentPrompt,
    digest: string,
    given: InstallGrant | undefined,
    agreed: (alsoOn?: string[]) => Promise<void>,
    /** Another machine's App page: the one it installs on (its agents are that machine's). */
    machine?: string,
    /** owner 10-16: the person's other computers it may also go on, with the same yes. */
    alsoOn?: InstallAlsoOnMachine[]
  ) => {
    const inShell = given || alsoOn?.length
      ? askInShell(prompt, `${digest}:${Date.now()}`, INSTALL_CONSENT_HUMAN_WINDOW_MS, given, undefined, machine, alsoOn)
      : null;
    if (inShell) {
      const answer = await inShell;
      if (answer.outcome === 'confirmed') await agreed(answer.alsoOn);
      return;
    }
    showConfirm({
      ...prompt,
      // The session page's own dialog draws the same body as the shell's sheet: with programs, their commands fold under it.
      description: prompt.details ? <ConsentBody description={prompt.description} details={prompt.details} /> : prompt.description,
      onSuccess: () => void agreed(),
    });
  };

  const install = async () => {
    setIsBusy(true);
    try {
      // 挑的是所选那台机器上的文件夹(另一台桌面时用新建框同一个「浏览」)。
      const sourceDir = await host.pickFolder({
        title: translate('extensions.chooseFolderTitle'),
        message: translate('extensions.chooseFolderMessage'),
      });
      if (!sourceDir) return;
      // The busy flag covers the picker and the read, and is released below.
      // It deliberately does *not* stay set while the dialog is up: the dialog
      // is modal and its overlay already blocks the button behind it, whereas
      // holding the flag would need a dismissal signal — and a dismissal by
      // Escape or by clicking outside never reaches the caller (the modal store
      // closes itself without telling anyone), which would leave Install
      // disabled until the screen remounted.
      await installFromDirectory(sourceDir);
    } catch (error) {
      toast({
        title: translate('extensions.installFailed'),
        description: messageForUser(error),
        tier: 'error',
      });
    } finally {
      setIsBusy(false);
    }
  };

  /** A folder the person picked, installed with the digest they agreed to. */
  const completeInstall = (sourceDir: string, ask: InstallConsentAsk): Promise<void> =>
    installing(
      ask.manifest,
      () => api.installFromFolder({ sourceDir, consent: { kind: 'given', digest: ask.manifestDigest } }),
      () => completeInstall(sourceDir, ask)
    );

  /** owner 10-16 The same release on another of the person's computers, with the yes given in the sheet (`installAgreedOn`). */
  const installOnAlso = async (deviceId: string, label: string, ask: InstallConsentAsk): Promise<void> => {
    try {
      const ref = { extensionId: ask.manifest.id, version: ask.manifest.version };
      await installAgreedOn((consent) => rpcOn(deviceId).extensions.installFromMarket({ ref, consent }), async () => ({ digest: ask.manifestDigest }));
      toast({ title: translateRef.current('extensions.bundleCardInstalledOn', { machine: label }), tier: 'success' });
    } catch (error) {
      log.error('extension market install on another computer failed:', { deviceId, error });
      toast({
        title: translateRef.current('extensions.installFailedOn', { machine: label }),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translateRef.current('extensions.retry'), onClick: () => void installOnAlso(deviceId, label, ask) },
      });
    }
  };

  /** A market App the person agreed to (`given`): main installs the very bytes it read for that consent. */
  const completeMarketInstall = (ask: InstallConsentAsk): Promise<void> =>
    installing(
      ask.manifest,
      () =>
        api.installFromMarket({
          ref: { extensionId: ask.manifest.id, version: ask.manifest.version },
          consent: { kind: 'given', digest: ask.manifestDigest },
        }),
      () => completeMarketInstall(ask)
    );

  /** Installing one App, as its card shows it: busy, then the list read again, its tabs, 「装好了」 — or why not, with a retry. */
  const installing = async (
    manifest: ExtensionManifest,
    run: () => Promise<{ success: boolean; error?: string }>,
    retry: () => Promise<void>
  ) => {
    if (inFlight.current[manifest.id] === 'installing') return;
    beginPending(manifest.id, 'installing');
    // 「装好了」那句只给第一次装上的;更新、换版本不说(它本来就在)。
    const firstInstall = !store.manifests.some((entry) => entry.id === manifest.id);
    try {
      const result = await run();
      if (!result.success) {
        throw new Error(result.error ?? '');
      }
      await refresh();
      // 装的这台机器上现在这一版,清出「有新版」的提示（或者换成刚装的这版还在跑的下一个）。
      void store.checkUpdates();
      // Its tab types become available now — no restart, per the product contract.
      // 另一台机器的 tab 由它自己的窗口补上(它收到清单变了的事件);这里只管本机窗口。
      if (host.local) await registerInstalledExtensionTabs();
      if (firstInstall) setJustInstalled(manifest.id);
      // "Did it work" and "what next" in one breath: the tab is where it went.
      toast({
        title: translateRef.current('extensions.installed', { name: localizedManifestText(manifest, locale).name }),
        description: translateRef.current('extensions.installedNext', {
          tabs: listOf(
            manifest.contributes.tabs.map((tab) => tab.title),
            locale
          ),
        }),
        tier: 'success',
      });
    } catch (error) {
      // Consent was given for this digest; retrying resends it, and the installer
      // still refuses if what it reads changed underneath.
      toast({
        title: translateRef.current('extensions.installFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void retry(),
        },
      });
    } finally {
      endPending(manifest.id);
    }
  };

  /**
   * Optimistic: the switch moves on the click and the write follows. If the
   * write fails the switch moves back and says why, with a way to try again.
   * Holding the switch still until IPC returns made every toggle feel ignored.
   */
  const setPermissionGranted = async (
    manifest: ExtensionManifest,
    permission: string,
    granted: boolean
  ) => {
    const key = `${manifest.id}\u0000${permission}`;
    if (permissionsInFlight.current[key]) return;
    permissionsInFlight.current = { ...permissionsInFlight.current, [key]: true };
    setPendingPermissions(permissionsInFlight.current);
    const apply = (list: readonly string[], on: boolean) =>
      on ? list.filter((entry) => entry !== permission) : [...new Set([...list, permission])];
    setRevoked((current) => ({
      ...current,
      [manifest.id]: apply(current[manifest.id] ?? [], granted),
    }));
    try {
      const result = await api.setPermissionGranted({
        extensionId: manifest.id,
        permission,
        granted,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error ?? '');
      }
      // What main enforces wins over what was assumed.
      setRevoked((current) => ({ ...current, [manifest.id]: result.data.revoked }));
    } catch (error) {
      // Roll back this one switch only: another switch on the same extension may
      // have landed meanwhile, and it keeps its own result.
      setRevoked((current) => ({
        ...current,
        [manifest.id]: apply(current[manifest.id] ?? [], !granted),
      }));
      toast({
        title: translateRef.current('extensions.permissionChangeFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void setPermissionGranted(manifest, permission, granted),
        },
      });
    } finally {
      const { [key]: _done, ...rest } = permissionsInFlight.current;
      permissionsInFlight.current = rest;
      setPendingPermissions(rest);
    }
  };

  /** 可用/不可用 — the rung between installed and uninstalled; optimistic, with rollback. */
  const switchExtension = async (manifest: ExtensionManifest, enabled: boolean) => {
    if (switching[manifest.id]) return;
    setSwitching((current) => ({ ...current, [manifest.id]: true }));
    try {
      await setExtensionEnabled(manifest, enabled, host);
    } catch (error) {
      log.error('extension switch refused:', error);
      toast({
        title: translateRef.current('extensions.switchFailed'), description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void switchExtension(manifest, enabled),
        },
      });
    } finally {
      setSwitching(({ [manifest.id]: _done, ...rest }) => rest);
    }
  };

  // The far-left rail is this machine's: its own Apps that are on and have a page of their own (no file to open).
  // 「打开」 in an App's details goes by the same rule: it does what the App's icon on the rail does.
  const onRail = (manifest: ExtensionManifest) =>
    !remote && store.isEnabled(manifest.id) && Boolean(store.mainTabOf(manifest.id));
  const dockToggle = (manifest: ExtensionManifest) =>
    !onRail(manifest)
      ? undefined
      : () =>
          void (store.dock.includes(manifest.id) ? unpinFromDock : pinToDock)(manifest.id).catch((error: unknown) => {
            log.error('dock change refused:', error);
            toast({ title: translateRef.current('extensions.dockFailed'), description: messageForUser(error), tier: 'error' });
          });
  const setDisclosure = async (manifest: ExtensionManifest, level: ExtensionDisclosureLevel) => {
    try {
      await store.setDisclosure(manifest.id, level);
    } catch (error) {
      log.error('extension disclosure refused:', error);
      toast({ title: translateRef.current('extensions.disclosureFailed'), description: messageForUser(error), tier: 'error' });
    }
  };

  // #6646 The chat's own forward page sends it (ExtensionForwardHost); exporting to a file is a row there.
  const forwardExtension = (manifest: ExtensionManifest) => {
    setDetail(null);
    window.dispatchEvent(new CustomEvent(UI_EVENTS.forwardExtension, { detail: { extensionId: manifest.id, name: localizedManifestText(manifest, locale).name, version: manifest.version } }));
  };

  /**
   * Every App goes out one way, a readable one or a folder no manifest this build runs (an older apiVersion among
   * them) — that one by its folder name, which is its id.
   */
  const confirmUninstall = (app: { id: string; name: string }) => {
    showConfirm({
      title: translate('extensions.uninstallConfirmTitle'),
      description: translate('extensions.uninstallConfirmDescription', { name: app.name }),
      confirmLabel: translate('extensions.uninstallAction'),
      variant: 'destructive',
      onSuccess: () => void uninstall(app),
    });
  };

  /**
   * Main's uninstall, and nothing else: its tabs are taken back by the inventory event every window follows
   * (`extensionsInventoryChangedChannel` → `resyncInstalledExtensionTabs`), which main sends before it answers.
   */
  const uninstall = async (app: { id: string; name: string }) => {
    if (inFlight.current[app.id]) return;
    beginPending(app.id, 'uninstalling');
    try {
      // A machine picked in the device picker that cannot be reached rejects instead of answering: the same failure.
      // I10 Off the last of the person's computers: its grants in chats go with it.
      const lastAnywhere = !(await installedElsewhere(app.id, remoteRef.current?.deviceId ?? null));
      const result = await host.api.uninstall({ extensionId: app.id, lastAnywhere });
      if (!result.success) throw new Error(result.error ?? '');
      await refresh();
      void store.checkUpdates();
      // 产品页上刚卸掉的那个:市场上还有就留在这一页(按钮回到「安装」),没有(文件夹装的)就回清单 ——
      // 一页讲一个已经不在盘上的东西,只会再给一次「卸载」。
      setDetail((current) => (current?.manifest.id === app.id && !current.installRef ? null : current));
      setJustInstalled((current) => (current === app.id ? null : current));
      // Uninstall is the one irreversible action here. When the bundle is on the
      // shelf the way back is one click on the toast; a hand-picked folder has
      // no shelf copy, so the toast only reports.
      const onShelf = await shelfItemFor(app.id);
      toast({
        title: translate('extensions.uninstalled', { name: app.name }),
        tier: 'success',
        ...(onShelf && {
          action: {
            label: translate('extensions.reinstall'),
            onClick: () => void installFromShelf(onShelf.ref, app.id),
          },
        }),
      });
    } catch (error) {
      toast({
        title: translate('extensions.uninstallFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translate('extensions.retry'), onClick: () => void uninstall(app) },
      });
    } finally {
      endPending(app.id);
    }
  };

  // ── derived views ───────────────────────────────────────────────────────
  const installedById = useMemo(
    () => new Map(store.manifests.map((manifest) => [manifest.id, manifest])),
    // mobx: `manifests` is observable; observer() re-renders when it changes.
    [store.manifests]
  );

  // 云端那口对这一个 id 要说的话,三选一(#5410);yanked/deprecated 比「有新版」急,
  // 与 installedGroupOf 的优先级一致。
  const updateFlagOf = (extensionId: string): InstalledUpdateFlag => {
    const updates = store.updates;
    if (!updates) return null;
    if (updates.yanked[extensionId]) return 'yanked';
    if (updates.deprecated[extensionId]) return 'deprecated';
    if (updates.updates[extensionId]) return 'update';
    return null;
  };
  const noticeOf = (manifest: ExtensionManifest): InstalledRowNotice | undefined => {
    const updates = store.updates;
    if (!updates) return undefined;
    const yanked = updates.yanked[manifest.id];
    if (yanked) return { kind: 'yanked', reason: yanked.reason, installable: yanked.installable };
    const deprecated = updates.deprecated[manifest.id];
    if (deprecated) {
      return { kind: 'deprecated', note: deprecated.note, replacedBy: deprecated.replacedBy };
    }
    const behind = updates.forkBehind?.[manifest.id];
    if (behind) return { kind: 'forkBehind', ...behind };
    const update = updates.updates[manifest.id];
    if (update) return { kind: 'update', version: update.version, releaseNotes: update.releaseNotes };
    // No longer in the market: said on its row, not counted as something to do (there is nothing to do).
    if (updates.gone?.includes(manifest.id)) return { kind: 'gone' };
    return undefined;
  };

  /**
   * 这一个 App 此刻那颗按钮(一个按钮走完一生):没装 = 安装(装不了就说为什么);装着停用了 = 启用;
   * 有能装的新版 = 更新;能打开 = 打开;都不是 = 只说「已安装」。`item` 是它在市场上的那一版(没有就只看装着的)。
   */
  const lifecycleOf = (extensionId: string, item?: Pick<ShelfItem, 'manifest' | 'cloud'>): AppLifecycle => {
    const installed = installedById.get(extensionId);
    const fork = store.origins[extensionId] === 'fork';
    return appLifecycle({
      installed,
      enabled: installed ? store.isEnabled(installed.id) : false,
      updateVersion: fork ? undefined : store.updates?.updates[extensionId]?.version,
      offered: fork ? undefined : item,
      preinstalled: store.isPreinstalled(extensionId),
      canOpen: installed ? onRail(installed) : false,
    }, translate);
  };

  const runLifecycle = (extensionId: string, item?: Pick<ShelfItem, 'manifest' | 'cloud' | 'ref'>) => {
    const state = lifecycleOf(extensionId, item);
    const installed = installedById.get(extensionId);
    if (!state) return;
    if (state.kind === 'get' && item) void installFromShelf(item.ref, extensionId);
    // 更新:没新增权限直接换(按「更新」本身就是同意,spec「装与卸」);新增了的照旧问那几项。
    else if (state.kind === 'update') void installFromShelf({ extensionId, version: state.version }, extensionId);
    else if (state.kind === 'enable' && installed) void switchExtension(installed, true);
    else if (state.kind === 'open') {
      setDetail(null);
      openApp(extensionId);
    }
  };

  /** 「对 agent 说」点一句:新建任务那一页,这句已经填在输入框里(它读新建框那一格草稿)。只在本机。 */
  const askAgent = remote
    ? undefined
    : (text: string) => {
        composerDrafts.set(NEW_SESSION_DRAFT_KEY, text);
        navigate('new-session');
      };

  const resourceOf = (extensionId: string) => ({ kind: 'app' as const, target: { kind: 'app-detail' as const, extensionId, deviceId: remote?.deviceId ?? readCachedDevices().find(device => device.is_current_device)?.device_id }, facts: store.updates?.forkBehind?.[extensionId] ? ['behind' as const] : [] });
  const menuOf = (manifest: ExtensionManifest) => ({
    resource: resourceOf(manifest.id),
    onToggleDock: dockToggle(manifest),
    onOpenInWindow: onRail(manifest)
      ? () => {
          setDetail(null);
          void openAppInWindow(manifest.id);
        }
      : undefined,
    onForward: host.local ? () => forwardExtension(manifest) : undefined,
    autoUpdate: autoUpdateOf(manifest),
    onUninstall: store.isPreinstalled(manifest.id) ? undefined : () => confirmUninstall(manifest),
  });
  // 「自动更新」(owner 10-19):市场装的才有。这台机器(或资源库里那一台)的主进程记着;打开回来,它当场更新一遍。
  const autoUpdateOf = (manifest: ExtensionManifest) => {
    const on = store.autoUpdates(manifest.id);
    if (on === null) return undefined;
    return {
      on,
      onToggle: (next: boolean) =>
        void store.setAutoUpdate(manifest.id, next).catch((error: unknown) => {
          log.error('auto-update switch refused:', error);
          toast({ title: translateRef.current('extensions.switchFailed'), description: messageForUser(error), tier: 'error' });
        }),
    };
  };
  const toggleOf = (manifest: ExtensionManifest) =>
    store.isPreinstalled(manifest.id) ? undefined : (enabled: boolean) => void switchExtension(manifest, enabled);

  const listedManifests = store.manifests.filter((manifest) => manifest.id !== WORKSPACE_APP_ID);
  const installedRows = listedManifests
    .filter((manifest) => matchesExtensionQuery(manifest, query))
    .sort((a, b) => a.name.localeCompare(b.name));
  const grouped: Record<InstalledGroup, ExtensionManifest[]> = {
    attention: [],
    update: [],
    active: [],
    disabled: [],
  };
  for (const manifest of installedRows) {
    grouped[installedGroupOf(store.isEnabled(manifest.id), updateFlagOf(manifest.id))].push(manifest);
  }
  const invalidRows =
    query.trim() === ''
      ? store.invalid
      : store.invalid.filter((entry) =>
          entry.dirName.toLowerCase().includes(query.trim().toLowerCase())
        );

  const marketRows = shelf.status === 'ready' ? shelf.items : [];

  const rememberListScroll = () => {
    listScroll.current = scroller()?.scrollTop ?? 0;
  };
  const openInstalledDetail = async (manifest: ExtensionManifest) => {
    rememberListScroll();
    // 先按装着的那份把这一页打开(点了就要有反应),再拿清单上的那一版补进去:它可能更新,
    // 这一页于是能给「更新」;分页的清单里未必已经取到它,所以定点问一次。
    setJustInstalled(null);
    setDetail({ manifest, installed: manifest, installRef: undefined, cloud: null });
    const onShelf = await shelfItemFor(manifest.id);
    if (!onShelf) return;
    setDetail((current) =>
      current?.manifest.id === manifest.id
        ? { manifest: onShelf.manifest, installed: manifest, installRef: onShelf.ref, cloud: onShelf.cloud }
        : current
    );
  };
  const openShelfDetail = (item: ShelfItem) => {
    rememberListScroll();
    setJustInstalled(null);
    setDetail({
      manifest: item.manifest,
      installed: installedById.get(item.manifest.id),
      installRef: item.ref,
      cloud: item.cloud,
    });
  };
  useAppDetailRequest({ target: detailLink, ready: inventory === 'ready', host, setDetail, detail, rootRef });
  // 产品页右栏「类似 App」点一个:换到它的产品页。❌ 记清单的滚动位置 —— 此刻滚的是产品页,回清单要回到进产品页之前那里。
  const openSimilar = (item: ShelfItem) => {
    setJustInstalled(null);
    setDetail({ manifest: item.manifest, installed: installedById.get(item.manifest.id), installRef: item.ref, cloud: item.cloud });
  };
  /** 市场里同一类的别的 App(取到的那几页里有的),最多五个。 */
  const similarOf = (manifest: ExtensionManifest) => {
    const category = marketCategoryOf(manifest);
    return marketRows
      .filter((item) => item.manifest.id !== manifest.id && marketCategoryOf(item.manifest) === category && !item.cloud.deprecated)
      .slice(0, 5)
      .map((item) => {
        const text = localizedManifestText(item.manifest, locale);
        return {
          id: item.manifest.id,
          name: text.name,
          publisher: translate('extensions.official'),
          line: localizedManifestText(item.manifest, locale).subtitle,
          iconUrl: item.cloud.iconUrl,
          onOpen: () => openSimilar(item),
        };
      });
  };
  /** 「已停止维护 · 改用 X」按钮:回市场,把搜索框填成那个替代扩展的 id。 */
  const browseReplacement = (replacementId: string) => {
    setDetail(null);
    setTab('market');
    setQuery(replacementId);
  };

  const installedCount = listedManifests.length;
  const searchPlaceholder = translate('extensions.searchPlaceholder');
  const pendingPermissionsOf = (extensionId: string) =>
    Object.keys(pendingPermissions)
      .filter((key) => key.startsWith(`${extensionId}\u0000`))
      .map((key) => key.slice(extensionId.length + 1));

  /** 已安装那一行名字下面那一句:有新版 / 撤回、停维(带下一步)/ 程序没起来 / 收回了几项 / 简介。 */
  const installedLine = (manifest: ExtensionManifest): ReactNode => {
    const notice = noticeOf(manifest);
    if (notice?.kind === 'update') return <span>{translate('extensions.rowHasUpdate', { version: notice.version })}</span>;
    if (notice) {
      return (
        // 句子里的链接词是它自己的事,❌ 顺带开产品页;点句子别处照常开。
        <span onClick={(event) => (event.target as HTMLElement).closest('button') && event.stopPropagation()}>
          <InstalledRowNoticeLine
            notice={notice}
            installedVersion={manifest.version}
            translate={translate}
            onInstallVersion={(version) => void installFromShelf({ extensionId: manifest.id, version }, manifest.id)}
            onBrowseReplacement={() => notice.kind === 'deprecated' && notice.replacedBy && browseReplacement(notice.replacedBy)}
          />
        </span>
      );
    }
    const failure = agentStatus[manifest.id]?.lastFailure;
    if (failure) {
      // 程序在 stderr 上的原话可能是一整段栈,不进文案(仓规 copy-leaks-internal-detail),放在悬停里给要追的人看。
      return (
        <span className="is-warn" title={failure.stderrTail || undefined}>
          {programFailureText(failure, translate)}
        </span>
      );
    }
    const declared = declaredPermissions(manifest);
    const withdrawn = declared.filter((permission) => (revoked[manifest.id] ?? []).includes(permission.key)).length;
    if (withdrawn > 0) return <span>{translate('extensions.rowRevoked', { count: withdrawn })}</span>;
    const text = localizedManifestText(manifest, locale);
    return <span>{text.description ?? translate('extensions.noDescription')}</span>;
  };

  const header = (aside?: ReactNode) => (
    // 照 Google Play 的应用首页:顶上不写说明句,标题、换机器、搜索就够了(owner 10-10 嫌字多)。
    <PageHeader sticky title={translate('settings.extensions')} aside={aside} />
  );

  // 别的机器此刻给不出清单、手上也没有上次的:只说那一句。页头照画 —— 换机器的选择器在页头上,❌ 让人困在这一句里。
  if (notice && !store.isLoaded) {
    return (
      <div className="mk" data-testid="extensions-store" ref={rootRef}>
        {header()}
        <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />
      </div>
    );
  }

  // ── 产品页:就在这一栏里铺开,左上「‹ App」回到清单 ──
  if (detail) {
    const installed = installedById.get(detail.manifest.id);
    const subject: ExtensionDetailSubject = { ...detail, installed };
    const item = detail.installRef && detail.cloud ? { manifest: detail.manifest, cloud: detail.cloud, ref: detail.installRef } : undefined;
    return (
      <div className="mk" data-testid="extensions-product" ref={rootRef}>
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />}
        <div className="pt-10 pb-14">
          <AppProductPage
            // 点「类似 App」是换一个 App:整页重来,❌ 带着上一个的截图、展开的版本历史画一帧。
            key={detail.manifest.id}
            subject={subject}
            iconDataUrl={installed ? store.appIcons[installed.id] : undefined}
            enabled={installed ? store.isEnabled(installed.id) : false}
            lifecycle={lifecycleOf(detail.manifest.id, item)}
            pending={pending[detail.manifest.id]}
            pendingPercent={downloadPercent[detail.manifest.id]}
            locale={locale}
            translate={translate}
            machine={remote?.deviceLabel}
            api={api}
            readOnly={!!notice?.readOnly}
            justInstalled={justInstalled === detail.manifest.id && Boolean(installed)}
            notice={installed ? noticeOf(installed) : undefined}
            variants={installed ? store.variants[installed.id] : undefined}
            onSwitchVariant={installed ? (name) => void switchVariant(installed, name) : undefined}
            revoked={installed ? (revoked[installed.id] ?? []) : []}
            pendingPermissions={installed ? pendingPermissionsOf(installed.id) : []}
            agentStatus={installed ? agentStatus[installed.id] : undefined}
            disclosure={installed ? store.disclosure[installed.id] : undefined}
            givenApi={api}
            docked={installed ? store.dock.includes(installed.id) : false}
            onBack={() => {
              setDetail(null);
              setJustInstalled(null);
            }}
            onLifecycle={() => runLifecycle(detail.manifest.id, item)}
            onInstallVersion={(ref) => void installFromShelf(ref, detail.manifest.id)}
            onTogglePermission={installed ? (permission, granted) => void setPermissionGranted(installed, permission, granted) : undefined}
            onDisclosureChange={installed ? (level) => void setDisclosure(installed, level) : undefined}
            onAsk={askAgent}
            onBrowseReplacement={browseReplacement}
            similar={similarOf(detail.manifest)}
            menu={installed ? { ...menuOf(installed), onToggleEnabled: toggleOf(installed) } : {}}
          />
        </div>
      </div>
    );
  }

  const search = (
    <SearchInput
      type="search"
      containerClassName="w-56"
      placeholder={searchPlaceholder}
      aria-label={searchPlaceholder}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );

  return (
    <div className="mk" data-testid="extensions-store" ref={rootRef}>
      {header(search)}
      {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />}
      {/* 离线 / server 太旧:照旧画上次读到的那份,所有按钮、开关一起灰(fieldset 的 disabled 传给里面每个控件)。 */}
      <fieldset disabled={!!notice?.readOnly} className="contents">
        {/* 「市场 / 已安装」用咕咕的分段(同面板页签那一种:无框、选中一块实底),❌ 自己再画一套。 */}
        <div className="mk-bar">
          <ToggleGroup
            size="sm"
            spacing={1}
            className="gap-1 overflow-visible border-none bg-transparent"
            aria-label={translate('extensions.title')}
            value={[tab]}
            onValueChange={([value]) => {
              if (value === 'market' || value === 'newest' || value === 'popular' || value === 'all' || value === 'installed') setTab(value);
            }}
          >
            {(
              [
                ['market', translate('extensions.recommended'), undefined],
                ['newest', translate('extensions.newest'), undefined],
                ['popular', translate('extensions.popular'), undefined],
                ['all', translate('extensions.allApps'), undefined],
                ['installed', translate('extensions.tabInstalled'), installedCount],
              ] as const
            ).map(([value, label, count]) => (
              <ToggleGroupItem key={value} value={value} className="gap-1 px-2 text-sm" data-testid={`extensions-tab-${value}`}>
                {label}
                {count !== undefined ? <span className="mk-seg-count">{count}</span> : null}
                {value === 'installed' && store.updateCount > 0 ? <span className="mk-seg-dot" aria-hidden /> : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => void install()}>
            {translate('extensions.installLocal')}
          </Button>
        </div>

        {tab !== 'installed' && (
          <div className="pb-14" data-testid="extensions-market-panel">
            {/* 那台机器此刻连不上:清单问不了(问了只会挂满超时),照实说,❌ 一直转骨架。 */}
            {/* 那台机器连不上时只有这一句:下面读清单的几种结果(转圈、出错、连不上下载站)都不画,❌ 两条「连不上」叠在一起。 */}
            {machineOffline ? (
              <div className="mk-status" role="status" data-testid="extension-market-offline">
                <span>{translate('extensions.marketOfflineUnreachable')}</span>
              </div>
            ) : null}
            {!machineOffline && shelf.status === 'loading' && (
              <div className="mk-sec">
                <ShelfSkeleton label={translate('extensions.loading')} />
              </div>
            )}

            {!machineOffline && shelf.status === 'error' && (
              <div className="mk-status" role="alert">
                <CircleAlert className="size-4 shrink-0" />
                <span className="min-w-0">{translate('extensions.marketUnavailable')}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void readShelf(debouncedQuery)}>
                  {translate('extensions.retry')}
                </Button>
              </div>
            )}

            {!machineOffline &&
              shelf.status === 'ready' &&
              (shelf.errorKind ? (
                // 连不上下载站:只说这一句和「重试」—— 市场只有这一个来源,已装的 App 照常能用(App 市场方案 10-07);
                // ❌ 再画「这里还没有 App」:读不到清单和清单是空的是两件事。
                <div className="mk-status" role="status" data-testid="extension-market-offline">
                  <span>{translate('extensions.marketOfflineUnreachable')}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void readShelf(debouncedQuery)}>
                    {translate('extensions.retry')}
                  </Button>
                </div>
              ) : (
                <AppMarketContent
                  resourceOf={resourceOf}
                    view={tab} onRetry={() => void readShelf(debouncedQuery)}
                  shelf={shelf}
                  chip={chip}
                  onChipChange={setChip}
                  query={debouncedQuery}
                  hostKey={host.key}
                  api={api}
                  lifecycleOf={lifecycleOf}
                  installedIds={new Set(installedById.keys())}
                  pending={pending}
                  downloadPercent={downloadPercent}
                  onOpen={openShelfDetail}
                  onAction={(item) => runLifecycle(item.manifest.id, item)}
                  sentinelRef={sentinelRef}
                  marketStale={marketStale ? translate('extensions.marketStale', { time: marketStaleTime(marketStale, locale) }) : null}
                />
              ))}
          </div>
        )}

        {tab === 'installed' && (
          <div className="pb-14" data-testid="extensions-installed-panel">
            {inventory === 'error' && !notice && (
              <div className="mk-status" role="alert">
                <CircleAlert className="size-4 shrink-0" />
                <span className="min-w-0">{translate('extensions.loadFailed')}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
                  {translate('extensions.retry')}
                </Button>
              </div>
            )}

            {inventory === 'loading' && installedRows.length === 0 && invalidRows.length === 0 && (
              <div className="mk-sec">
                <InstalledRowsSkeleton label={translate('extensions.loading')} />
              </div>
            )}

            {INSTALLED_GROUP_ORDER.map((group) => {
              const rows = grouped[group];
              const broken = group === 'attention' ? invalidRows : [];
              if (rows.length === 0 && broken.length === 0) return null;
              return (
                <section className="mk-sec" key={group} data-testid={`extensions-installed-${group}`}>
                  <h3>
                    {translate(GROUP_LABEL[group])}
                    <span className="mk-count">{rows.length + broken.length}</span>
                  </h3>
                  <ul className="mk-list">
                    {broken.map((entry) => (
                      <li
                        key={entry.dirName}
                        className="mk-row"
                        data-testid="extension-row-unreadable"
                        data-extension-dir={entry.dirName}
                      >
                        <span className="mk-icon">
                          <ExtensionMonogram name={entry.dirName} broken />
                        </span>
                        <div className="mk-tx">
                          <b>
                            <span className="mk-name">{entry.dirName}</span>
                            <em>{translate('extensions.unreadableShort')}</em>
                          </b>
                          <span className="xp-row-error" title={entry.reason}>
                            {translate('extensions.unreadable', { name: entry.dirName, reason: entry.reason })}
                          </span>
                        </div>
                        {/* Unreadable is still installed: removable here, as every other row is (L11 复核 60). */}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="hover:text-foreground-destructive"
                          data-testid="extension-row-unreadable-uninstall"
                          aria-label={translate('extensions.uninstallAction')}
                          title={translate('extensions.uninstallAction')}
                          onClick={() => confirmUninstall({ id: entry.dirName, name: entry.dirName })}
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </li>
                    ))}
                    {rows.map((manifest) => (
                      <InstalledAppRow
                        key={manifest.id}
                        id={manifest.id}
                        name={`${localizedManifestText(manifest, locale).name}${store.variants[manifest.id]?.active && store.variants[manifest.id]!.active !== 'upstream' ? ` · ${store.variants[manifest.id]!.active}` : ''}`}
                        version={manifest.version}
                        line={installedLine(manifest)}
                        iconUrl={store.appIcons[manifest.id]}
                        enabled={store.isEnabled(manifest.id)}
                        switching={switching[manifest.id] === true}
                        lifecycle={lifecycleOf(manifest.id)}
                        pending={pending[manifest.id]}
                        pendingPercent={downloadPercent[manifest.id]}
                        docked={store.dock.includes(manifest.id)}
                        translate={translate}
                        onOpen={() => void openInstalledDetail(manifest)}
                        onAction={() => runLifecycle(manifest.id)}
                        onToggleEnabled={toggleOf(manifest)}
                        menu={menuOf(manifest)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}

            {inventory === 'ready' && installedRows.length === 0 && invalidRows.length === 0 && (
              <div className="mk-empty">
                {query.trim() === '' ? translate('extensions.empty') : translate('extensions.noMatch', { query: query.trim() })}
                {query.trim() === '' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setTab('market')}>
                    {translate('extensions.browseMarket')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>
    </div>
  );
});
