/**
 * The shape of the content, at rest, until it arrives. A spinner in the middle of
 * an empty panel says "wait" and then jumps the page when the rows land; these
 * keep the rows' and cards' own heights so loading → loaded is a fill-in, not a
 * reflow. Refs #5265 (state-change review).
 */

const ROW_WIDTHS = ['is-w2', 'is-w3', 'is-w1'] as const;

export function InstalledRowsSkeleton({ label }: { label: string }) {
  return (
    <ul className="xp-rows" role="status" aria-label={label} aria-busy="true">
      {ROW_WIDTHS.map((width, index) => (
        <li key={index} className="xp-row is-skeleton" aria-hidden>
          <span className="xp-skel xp-skel-glyph" />
          <div className="xp-copy">
            <span className={`xp-skel xp-skel-line ${width}`} />
            <span className="xp-skel xp-skel-line is-w4 is-dim" />
          </div>
        </li>
      ))}
    </ul>
  );
}

const CARD_WIDTHS = ['is-w2', 'is-w1', 'is-w3', 'is-w2', 'is-w3', 'is-w1'] as const;

export function ShelfSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="xp-group">
      <p className="xp-group-title" aria-hidden>
        <span className="xp-skel xp-skel-line is-w1" />
      </p>
      <div className="xp-card-grid" aria-hidden>
        {CARD_WIDTHS.map((width, index) => (
          <div key={index} className="xp-card is-skeleton">
            <span className="xp-skel xp-skel-glyph" />
            <span className="xp-copy">
              <span className={`xp-skel xp-skel-line ${width}`} />
              <span className="xp-skel xp-skel-line is-w4 is-dim" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 取下一页时接在网格底下的一行:两张卡的形状,取完就被真卡片替掉。 */
export function ShelfMoreSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="xp-card-grid" aria-hidden>
      {(['is-w2', 'is-w3'] as const).map((width, index) => (
        <div key={index} className="xp-card is-skeleton">
          <span className="xp-skel xp-skel-glyph" />
          <span className="xp-copy">
            <span className={`xp-skel xp-skel-line ${width}`} />
            <span className="xp-skel xp-skel-line is-w4 is-dim" />
          </span>
        </div>
      ))}
    </div>
  );
}
