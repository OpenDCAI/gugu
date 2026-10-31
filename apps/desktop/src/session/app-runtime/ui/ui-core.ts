import { formatCalendarDay } from '@gugu/session-shared/format';
import { ICON_ALIASES, ICON_BODIES, ICON_ATTRIBUTES } from '@gugu/session-ui/icon-bodies';

/** The DOM-free half of ui.js (ui-entry.ts): what its elements say, testable without a page. */

/** lucide's names: `AlertTriangle` → `alert-triangle`, `BarChart3` → `bar-chart-3`, `XCircle` → `x-circle`. */
export function iconName(exportName: string): string {
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Every glyph of gugu's icon set (packages/session-ui, the one the app draws with) under its lucide name — the set is
 * lucide's drop-in, and lucide's are the names a model knows — plus the aliases that are names of their own
 * (`circle-alert`, `triangle-alert`), not lucide's `…Icon` suffixes.
 */
export const ICONS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ICON_BODIES).map(([name, body]) => [iconName(name), body] as const),
  ...Object.entries(ICON_ALIASES)
    .filter(([alias]) => !alias.endsWith('Icon'))
    .map(([alias, target]) => [iconName(alias), ICON_BODIES[target]!] as const),
]);

/** The same SVG defaults as the React factory, including copied stroke widths and classes. */
export const ICON_SVG_ATTRIBUTES: ReadonlyMap<string, Record<string, string | number>> = new Map([
  ...Object.entries(ICON_ATTRIBUTES).map(([name, attributes]) => [iconName(name), attributes] as const),
  ...Object.entries(ICON_ALIASES)
    .filter(([alias, target]) => !alias.endsWith('Icon') && target in ICON_ATTRIBUTES)
    .map(([alias, target]) => [iconName(alias), ICON_ATTRIBUTES[target]!] as const),
]);

/** How gugu's own lists say a time: relative within the hour, then the host lists' own writing (clock today, 昨天, the date). */
export function timePhrase(date: Date, now: Date, zh: boolean): string {
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (Math.abs(seconds) < 45) return zh ? '刚刚' : 'just now';
  if (seconds > 0 && seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  }
  return formatCalendarDay(date, zh ? 'zh-CN' : 'en-US', { now });
}
