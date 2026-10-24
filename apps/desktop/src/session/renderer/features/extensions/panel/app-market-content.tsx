import type { Ref } from 'react';
import { AppFeaturedCard } from './app-featured';
import { AppShelfRow } from './app-shelf';
import { MarketAppRow } from './app-rows';
import type { AppLifecycle } from './app-lifecycle-button';
import type { ProductPageApi } from './app-product-page';
import type { ExtensionPendingAction } from './extension-pending';
import { ShelfMoreSkeleton } from './extension-skeletons';
import { Button } from '@renderer/lib/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { cn } from '@renderer/utils/utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { featuredBody, localizedManifestText, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog';
import type { MarketListItem, MarketCompat } from '@shared/extensions/market';

type ShelfItem = MarketListItem;
const HOME_SHELF_ROWS = 6;

export type AppMarketState =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** 这是哪个搜索词的结果(空串 = 不搜):同一个词再读一遍时,画着的这份留着,读回来原地换上。 */
      query: string;
      /** 云端连不上时,用户该做什么这一类。原话只进日志,❌ 不进文案。 */
      errorKind: 'unreachable' | null;
      items: ShelfItem[];
      invalid: { dirName: string; reason: string }[];
      total: number;
      page: number;
      hasMore: boolean;
      /** 首页精选那一排(只随不带搜索词的第一页;近期安装量排出来,不够用官方标的补齐)。 */
      featured: ShelfItem[];
      /** 精选下面那几排:「最新」、「热门」(近期安装分数够数才有)和够数的类别各一排(同精选,只随不带搜索词的第一页)。 */
      // `popular` 可选:看的是另一台咕咕、它还是旧版时不带这一排。
      home: { newest: ShelfItem[]; popular?: ShelfItem[]; shelves: { category: MarketCategory; items: ShelfItem[] }[] };
      /** 正在取下一页:底部画骨架、哨兵不再触发。 */
      loadingMore: boolean;
    }
  | { status: 'error' };


/** The market's browsing surface, shared by desktop and the phone's App page. */
export function AppMarketContent({ shelf, query, hostKey, api, lifecycleOf, pending, downloadPercent, onOpen, onAction, sentinelRef, marketStale, installedIds, chip, onChipChange: setChip }: {
  shelf: Extract<AppMarketState, { status: 'ready' }>;
  query: string;
  hostKey: string;
  api: Pick<ProductPageApi, 'marketReadme'>;
  lifecycleOf: (id: string, item: ShelfItem) => AppLifecycle;
  pending: Record<string, ExtensionPendingAction>;
  downloadPercent: Record<string, number>;
  onOpen: (item: ShelfItem) => void;
  onAction: (item: ShelfItem) => void;
  sentinelRef?: Ref<HTMLDivElement>;
  marketStale?: string | null;
  installedIds: ReadonlySet<string>;
  chip: 'all' | MarketCategory;
  onChipChange: (chip: 'all' | MarketCategory) => void;
}) {
  const { translate, locale } = useSessionMessages();
  const compatText = (compat: NonNullable<MarketCompat>) => compat.reason === 'needs-newer-app' ? translate('extensions.needsNewerApp', { version: compat.minAppVersion }) : translate('extensions.needsAuthorUpdate');
  // 市场那一侧的筛选在服务端,这里拿到的已经是结果;次序也是那边排好的(先按类别,再按名字)。
  const marketRows = shelf.items;
  // 类别那一排只列取到的清单里有的类(次序同清单:先按类别再按名字);选中的那类没了(搜别的了)就当「全部」。
  const chipKeys: ('all' | MarketCategory)[] = ['all'];
  for (const item of marketRows) {
    const category = marketCategoryOf(item.manifest);
    if (!chipKeys.includes(category)) chipKeys.push(category);
  }
  const activeChip = chipKeys.includes(chip) ? chip : 'all';
  const shownRows = activeChip === 'all' ? marketRows : marketRows.filter((item) => marketCategoryOf(item.manifest) === activeChip);
  const chipLabel = (key: 'all' | MarketCategory) => translate(key === 'all' ? 'extensions.chipAll' : `extensions.category.${key}`);
  const gridTitle =
    query !== '' ? translate('extensions.searchResults') : activeChip === 'all' ? translate('extensions.allApps') : chipLabel(activeChip);

  /** 精选大卡 / 「最新」小卡:同一个组件,同一张底图(README 第一张截图,没有就用图标)。 */
  const featuredCardOf = (item: ShelfItem, variant: 'hero' | 'card') => {
    const text = localizedManifestText(item.manifest, locale);
    return (
      <AppFeaturedCard
        key={item.manifest.id}
        variant={variant}
        hostKey={hostKey}
        id={item.manifest.id}
        version={item.manifest.version}
        name={text.name}
        subtitle={text.subtitle}
        body={featuredBody(text.description ?? '', text.subtitle)}
        meta={variant === 'card' ? text.subtitle : `${translate(`extensions.category.${marketCategoryOf(item.manifest)}`)} · ${translate('extensions.official')}`}
        iconUrl={item.cloud.iconUrl}
        lifecycle={lifecycleOf(item.manifest.id, item)}
        pending={pending[item.manifest.id]}
        pendingPercent={downloadPercent[item.manifest.id]}
        api={api}
        translate={translate}
        onOpen={() => onOpen(item)}
        onAction={() => onAction(item)}
      />
    );
  };

  /**
   * 市场里的一行。状态只在按钮那一格(❌ 写进副标题):没装的里,停止维护了的写「已停止维护」,这台咕咕装不了的写短的
   * 那一句(行上放不下版本号,整句在悬停提示里;产品页照旧写整句)。
   */
  const marketRowOf = (item: ShelfItem) => {
    const id = item.manifest.id;
    const text = localizedManifestText(item.manifest, locale);
    const here = installedIds.has(id);
    const compat = item.cloud.compat;
    const word: AppLifecycle | undefined = here
      ? undefined
      : item.cloud.deprecated
        ? { kind: 'word', text: translate('extensions.deprecated') }
        : compat
          ? {
              kind: 'word',
              text: translate(compat.reason === 'needs-newer-app' ? 'extensions.tileNeedsApp' : 'extensions.needsAuthorUpdate'),
              title: compatText(compat),
            }
          : undefined;
    return (
      <MarketAppRow
        key={id}
        id={id}
        name={text.name}
        subtitle={text.subtitle}
        iconUrl={item.cloud.iconUrl}
        deprecated={Boolean(item.cloud.deprecated)}
        lifecycle={word ?? lifecycleOf(id, item)}
        pending={pending[id]}
        pendingPercent={downloadPercent[id]}
        translate={translate}
        onOpen={() => onOpen(item)}
        onAction={() => onAction(item)}
      />
    );
  };

  return (
                <>
                  {chipKeys.length > 2 ? (
                    <ToggleGroup
                      size="sm"
                      spacing={2}
                      variant="outline"
                      className="mk-chipbar"
                      aria-label={translate('extensions.infoCategory')}
                      value={[activeChip]}
                      onValueChange={([value]) => {
                        if (value) setChip(value as 'all' | MarketCategory);
                      }}
                    >
                      {chipKeys.map((key) => (
                        <ToggleGroupItem key={key} value={key} data-testid={`extensions-market-chip-${key}`}>
                          {chipLabel(key)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  ) : null}
                  {shelf.featured.length > 0 && query === '' && activeChip === 'all' ? (
                    // 精选那一排(App Store 首页顶上那排大卡):几张就横着翻几张、下面一排页码点,一张时铺满。
                    <AppShelfRow
                      label={translate('extensions.featured')}
                      prevLabel={translate('extensions.shelfPrev')}
                      nextLabel={translate('extensions.shelfNext')}
                      className={cn('mk-hero', shelf.featured.length > 1 && 'is-multi')}
                      dots
                    >
                      {shelf.featured.map((item) => featuredCardOf(item, 'hero'))}
                    </AppShelfRow>
                  ) : null}

                  {/* 精选下面那几排(App Store 发现页那几排):「最新」是截图小卡,「热门」和够数的类别是 App 行;
                      每排都横着滑、露出下一列,窄窗也一样;搜索或选了一类时不画。 */}
                  {query === '' && activeChip === 'all' && shelf.home.newest.length > 0 ? (
                    <section className="mk-sec" data-testid="extensions-market-newest">
                      <div className="mk-sec-bar">
                        <h3>{translate('extensions.newest')}</h3>
                      </div>
                      <AppShelfRow label={translate('extensions.newest')} prevLabel={translate('extensions.shelfPrev')} nextLabel={translate('extensions.shelfNext')} className="mk-card-shelf">
                        {shelf.home.newest.map((item) => featuredCardOf(item, 'card'))}
                      </AppShelfRow>
                    </section>
                  ) : null}
                  {query === '' && activeChip === 'all'
                    ? [
                        ...(shelf.home.popular?.length ? [{ key: 'popular', title: translate('extensions.popular'), items: shelf.home.popular, chip: null }] : []),
                        ...shelf.home.shelves.map(({ category, items }) => ({ key: `shelf-${category}`, title: chipLabel(category), items, chip: category })),
                      ].map(({ key, title, items, chip }) => (
                        <section className="mk-sec" key={key} data-testid={`extensions-market-${key}`}>
                          <div className="mk-sec-bar">
                            <h3>{title}</h3>
                            {chip && items.length > HOME_SHELF_ROWS ? (
                              <Button type="button" variant="ghost" size="sm" data-testid={`extensions-market-see-all-${chip}`} onClick={() => setChip(chip)}>
                                {translate('extensions.seeAll')}
                              </Button>
                            ) : null}
                          </div>
                          {/* App Store 的列表分区:按列排,每列最多三行,一屏三列。 */}
                          <AppShelfRow
                            label={title}
                            prevLabel={translate('extensions.shelfPrev')}
                            nextLabel={translate('extensions.shelfNext')}
                            className={`mk-lockup-shelf is-rows-${Math.min(3, Math.ceil(Math.min(items.length, HOME_SHELF_ROWS) / 3))}`}
                          >
                            {items.slice(0, HOME_SHELF_ROWS).map(marketRowOf)}
                          </AppShelfRow>
                        </section>
                      ))
                    : null}

                  {marketRows.length === 0 ? (
                    <div className="mk-empty">
                      {query === ''
                        ? translate('extensions.marketEmpty')
                        : translate('extensions.noMatch', { query: query })}
                    </div>
                  ) : (
                    // 一行一个 App(App Store 的 App 行),桌面三列、窄了两列、再窄一列(app-store.css 的容器查询)。
                    <section className="mk-sec" data-testid={`extensions-market-section-${query !== '' ? 'results' : activeChip}`}>
                      <h3>
                        {gridTitle}
                        <span className="mk-count">{shownRows.length}</span>
                        {/* 后台那趟没取到:画的是手上那份,安静说它是几点的;❌ 弹错、❌ 错误面板。写在标题这一行里,出现、消失都不挪格子。 */}
                        {marketStale ? (
                          <span className="mk-stale" data-testid="extension-market-stale">
                            {marketStale}
                          </span>
                        ) : null}
                      </h3>
                      <div className="mk-lockups" role="list" aria-label={gridTitle}>
                        {shownRows.map(marketRowOf)}
                      </div>
                    </section>
                  )}

                  {/* 翻页:滚到这一行就自动取下一页。还有下一页时写着取到第几条,取的时候换成骨架,取完接在最后一区后面,
                      ❌ 不整页重画 —— 翻页要看得见,但不要他动手。全取完了这一行就不在:❌ 页脚再报一遍「共几个」。 */}
                  {marketRows.length > 0 && shelf.hasMore ? (
                    <div className="mk-foot" ref={sentinelRef} data-testid="extension-market-more">
                      {shelf.loadingMore ? (
                        <ShelfMoreSkeleton label={translate('extensions.loading')} />
                      ) : (
                        translate('extensions.marketShown', { shown: shelf.items.length, total: shelf.total })
                      )}
                    </div>
                  ) : null}

                  {shelf.invalid.length > 0 && (
                    <ul className="xp-note-list">
                      {shelf.invalid.map((entry) => (
                        <li key={entry.dirName}>{translate('extensions.marketInvalid', { name: entry.dirName })}</li>
                      ))}
                    </ul>
                  )}
                </>
  );
}
