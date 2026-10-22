import type { ReactNode } from 'react';
import type { MarketCategory } from '@shared/extensions/catalog';
import { AppShelfRow } from './app-shelf';
import { ExtensionMonogram } from './extension-monogram';

/**
 * 市场首页一排(照 Google Play:一排一个推荐理由):标题、下面一句为什么是这几个、一排 App 行横着滑。
 * 格子照旧是 App 行(64px 图标):owner 10-10 嫌 Google Play 那种 140px 大图标过大。
 */
export function MarketSectionShelf({
  testId,
  title,
  subtitle,
  prevLabel,
  nextLabel,
  children,
  count,
}: {
  testId: string;
  title: string;
  subtitle: string;
  prevLabel: string;
  nextLabel: string;
  /** 几个 App:决定一列放几行(1–3),一屏三列。 */
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mk-sec" data-testid={testId}>
      <div className="mk-sec-bar">
        <h3>
          {title}
          <span className="mk-sec-sub">{subtitle}</span>
        </h3>
      </div>
      <AppShelfRow label={title} prevLabel={prevLabel} nextLabel={nextLabel} className={`mk-lockup-shelf is-rows-${Math.min(3, Math.ceil(count / 3))}`}>
        {children}
      </AppShelfRow>
    </section>
  );
}

/** 「类别」页:一类一张卡,写这一类几个、前三个的图标(照 Google Play 的类别页)。点一张 = 那一类的列表。 */
export function MarketCategoryCards({
  cards,
  labelOf,
  countOf,
  onPick,
}: {
  cards: readonly { category: MarketCategory; count: number; icons: readonly (string | null)[] }[];
  labelOf: (category: MarketCategory) => string;
  countOf: (count: number) => string;
  onPick: (category: MarketCategory) => void;
}) {
  return (
    <div className="mk-cats" role="list">
      {cards.map((card) => (
        <button type="button" role="listitem" className="mk-cat" key={card.category} data-testid={`extensions-market-category-${card.category}`} onClick={() => onPick(card.category)}>
          <span className="mk-cat-tx">
            <b>{labelOf(card.category)}</b>
            <span>{countOf(card.count)}</span>
          </span>
          <span className="mk-cat-icons" aria-hidden>
            {card.icons.map((icon, index) => (
              <span className="mk-icon is-28" key={index}>
                <ExtensionMonogram name={labelOf(card.category)} iconDataUrl={icon} />
              </span>
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}
