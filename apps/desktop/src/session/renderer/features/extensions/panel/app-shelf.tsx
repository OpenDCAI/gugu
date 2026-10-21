import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';

/**
 * 一排(owner 10-10 指 Google Play「这个是我想要的」):放不下就横着滚,鼠标放在这一排上时两头出一颗圆的
 * 「上一组 / 下一组」(照 Google Play:能往哪边翻才出哪边那颗)。产品页的截图、市场首页的精选和各排都用它。
 * `dots`:下面一排页码点,标出此刻翻到第几张(App Store 首页顶上那排大图);只是指示,翻页仍用两头那颗钮。
 */
export function AppShelfRow({
  label,
  prevLabel,
  nextLabel,
  className,
  dots = false,
  children,
}: {
  label?: string;
  prevLabel: string;
  nextLabel: string;
  className?: string;
  dots?: boolean;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ prev: false, next: false, at: 0 });
  // 只在格子数变了时重挂观察;children 每次重画都是新的引用(下载进度一跳就重画),❌ 拿它当依赖。
  const count = Children.count(children);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const max = row.scrollWidth - row.clientWidth;
    // 翻到第几张:左边沿离此刻滚到的位置最近的那一张;滚到底时算最后一张(最后一张可能比一屏窄,左边沿永远到不了)。
    const items = Array.from(row.children) as HTMLElement[];
    const start = items[0]?.offsetLeft ?? 0;
    const at =
      row.scrollLeft >= max - 1 && max > 0
        ? items.length - 1
        : items.reduce((best, item, index) => (Math.abs(item.offsetLeft - start - row.scrollLeft) < Math.abs(items[best]!.offsetLeft - start - row.scrollLeft) ? index : best), 0);
    setEdge({ prev: row.scrollLeft > 1, next: row.scrollLeft < max - 1, at });
  }, []);

  useEffect(() => {
    measure();
    const row = rowRef.current;
    if (!row) return;
    const view = row.ownerDocument.defaultView;
    // 宽度变了(分屏、拖窗口)或者截图加载出来撑开了,都要重算两头能不能翻。
    const Observer = view?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, count]);

  const page = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    // 一次翻一屏少一点,留半格让人看出接着哪儿(Google Play 同样)。
    row.scrollBy({ left: direction * Math.max(row.clientWidth * 0.85, 160), behavior: 'smooth' });
  };

  return (
    <div className={cn('mk-shelf', className)}>
      <div ref={rowRef} className="mk-shelf-row" role="list" aria-label={label} onScroll={measure}>
        {children}
      </div>
      {dots && count > 1 ? (
        <div className="mk-dots" aria-hidden>
          {Array.from({ length: count }, (_, index) => (
            <i key={index} className={index === edge.at ? 'is-on' : undefined} />
          ))}
        </div>
      ) : null}
      {edge.prev ? (
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          className="mk-shelf-arrow is-prev"
          aria-label={prevLabel}
          title={prevLabel}
          onClick={() => page(-1)}
        >
          <ChevronLeft className="size-5" />
        </Button>
      ) : null}
      {edge.next ? (
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          className="mk-shelf-arrow is-next"
          aria-label={nextLabel}
          title={nextLabel}
          onClick={() => page(1)}
        >
          <ChevronRight className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
