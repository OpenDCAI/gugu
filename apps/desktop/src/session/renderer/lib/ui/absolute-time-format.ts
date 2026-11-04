import { formatCalendarDate } from '@/i18n/format';

/** Session chrome and transcript dates share the same explicit-locale formatter. */
export function formatAbsoluteTime(date: Date, locale: string, opts: { includeYear?: boolean; now?: Date } = {}): string {
  return formatCalendarDate(date, locale, opts);
}
