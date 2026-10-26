import { useState, type ComponentProps } from 'react';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';

/** The visible tabs, plus at most three recently viewed tabs. Never mount an unvisited restored tab. */
export const KEPT_HIDDEN_TABS = 3;

export function useRetainedTabs(available: readonly string[], shown: readonly string[]): ReadonlySet<string> {
  const [recent, setRecent] = useState<readonly string[]>([]);
  const open = new Set(available);
  const visible = new Set(shown.filter((id) => open.has(id)));
  const next = [
    ...visible,
    ...recent.filter((id) => open.has(id) && !visible.has(id)).slice(0, KEPT_HIDDEN_TABS),
  ];
  if (next.length !== recent.length || next.some((id, index) => id !== recent[index])) setRecent(next);
  return new Set(next);
}

/** Keeps layout and state while removing the hidden content from painting, focus, and find. */
export function RetainedTabContent({ visible, style, ...props }: ComponentProps<'div'> & { visible: boolean }) {
  return <div {...props} style={visible ? style : { ...RETAINED_SURFACE_HIDDEN_STYLE, ...style }} />;
}
