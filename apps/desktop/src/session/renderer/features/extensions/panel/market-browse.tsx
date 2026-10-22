import type { MarketCategory } from '@shared/extensions/catalog';

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
            {/* 没有图标的 App 不画占位(画的会是类别名的首字,不是那个 App)。 */}
            {card.icons
              .filter((icon): icon is string => Boolean(icon))
              .map((icon) => (
                <span className="mk-icon is-28" key={icon}>
                  <img src={icon} alt="" loading="lazy" decoding="async" />
                </span>
              ))}
          </span>
        </button>
      ))}
    </div>
  );
}
