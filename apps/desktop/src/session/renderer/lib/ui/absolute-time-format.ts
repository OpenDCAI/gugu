import { format } from 'date-fns';

/**
 * 「已安排」页的绝对时间。中文界面写「10月15日 07:07」(不是今年才带年份),❌ 英文月份缩写「Oct 15, 07:07」
 * 混在中文句子里;其它语言保持原来的写法。与任务历史(`session-history-row` 的 formatDateTime)同一个分法:按界面语言,
 * zh 走中文模板。
 */
export function formatAbsoluteTime(date: Date, locale: string, opts: { includeYear?: boolean; now?: Date } = {}): string {
  const showYear = opts.includeYear || date.getFullYear() !== (opts.now ?? new Date()).getFullYear();
  if (locale.startsWith('zh')) {
    return format(date, showYear ? "yyyy'年'M'月'd'日' HH:mm" : "M'月'd'日' HH:mm");
  }
  return format(date, showYear ? 'MMM d yyyy, HH:mm' : 'MMM d, HH:mm');
}
