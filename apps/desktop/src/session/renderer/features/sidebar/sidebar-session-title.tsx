import { assignInlineVars } from '@vanilla-extract/dynamic';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { useMediaQuery } from '@renderer/lib/hooks/use-media-query';
import * as styles from './sidebar-session-title.css';

/** Keep the row's geometry fixed while a long title reveals its end on hover. */
export function SidebarSessionTitle({ title, className }: { title: string; className?: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [metrics, setMetrics] = useState({ distance: 0, duration: 0 });

  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const measure = () => {
      const overflow = inner.getBoundingClientRect().width - outer.clientWidth;
      const distance = outer.clientWidth > 0 && overflow >= 1 ? overflow : 0;
      const fontSize = Number.parseFloat(getComputedStyle(inner).fontSize);
      const duration = distance / (fontSize * 2);
      setMetrics((previous) => previous.distance === distance && previous.duration === duration
        ? previous : { distance, duration });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [title, metrics.distance]);

  return (
    <span
      ref={viewport}
      className={cn(styles.viewport, className)}
      data-overflow={metrics.distance > 0 || undefined}
      title={reducedMotion ? title : undefined}
      style={assignInlineVars({ [styles.distance]: `${metrics.distance}px`, [styles.duration]: `${metrics.duration}s` })}
    >
      <span
        ref={content}
        // Replacing an overflowing title or resizing its lane restarts at the beginning.
        key={`${title}:${metrics.distance}`}
        className={styles.content}
      >{title}</span>
    </span>
  );
}
