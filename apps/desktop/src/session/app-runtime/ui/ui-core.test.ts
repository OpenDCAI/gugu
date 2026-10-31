import { describe, expect, it } from 'vitest';
import { ICON_ALIASES, ICON_BODIES } from '@gugu/session-ui/icon-bodies';
import { ICONS, iconName, timePhrase } from './ui-core';

describe('<gugu-icon> names: gugu\'s Solar set under lucide\'s names', () => {
  it('names the way lucide does', () => {
    expect(iconName('Bell')).toBe('bell');
    expect(iconName('AlertTriangle')).toBe('alert-triangle');
    expect(iconName('BarChart3')).toBe('bar-chart-3');
    expect(iconName('Trash2')).toBe('trash-2');
    expect(iconName('XCircle')).toBe('x-circle');
    expect(iconName('MessageSquarePlus')).toBe('message-square-plus');
  });

  it('has every glyph the app draws with, and the aliases that are names of their own — not the …Icon suffixes', () => {
    for (const name of Object.keys(ICON_BODIES)) expect(ICONS.get(iconName(name)), name).toBe(ICON_BODIES[name]);
    expect(ICONS.get('triangle-alert')).toBe(ICON_BODIES.AlertTriangle);
    for (const alias of Object.keys(ICON_ALIASES).filter((name) => name.endsWith('Icon'))) {
      expect(ICONS.has(iconName(alias)), alias).toBe(false);
    }
    for (const body of ICONS.values()) expect(body).toMatch(/^<[a-z]/);
  });
});

describe('<gugu-time>: as gugu\'s own lists say a time', () => {
  const now = new Date(2026, 9, 5, 12, 0, 0);
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts);

  it('within the hour: relative; today: the clock; yesterday: 昨天; this year: the date; before: the year too', () => {
    expect(timePhrase(new Date(now.getTime() - 20_000), now, true)).toBe('刚刚');
    expect(timePhrase(new Date(now.getTime() - 3 * 60_000), now, true)).toBe('3 分钟前');
    expect(timePhrase(new Date(now.getTime() - 3 * 60_000), now, false)).toBe('3 min ago');
    expect(timePhrase(at(2026, 9, 5, 8, 20), now, true)).toBe('08:20');
    expect(timePhrase(at(2026, 9, 4, 14, 20), now, true)).toBe('昨天');
    expect(timePhrase(at(2026, 9, 4, 14, 20), now, false)).toBe('yesterday');
    expect(timePhrase(at(2026, 7, 3, 9, 0), now, true)).toBe('8月3日');
    expect(timePhrase(at(2025, 10, 20, 9, 0), now, true)).toBe('2025年11月20日');
  });

  it('a time ahead (a deadline) is said as its clock or date, never as "ago"', () => {
    expect(timePhrase(at(2026, 9, 5, 22, 0), now, true)).toBe('22:00');
    expect(timePhrase(at(2026, 9, 9, 22, 0), now, false)).toBe('Oct 9');
  });
});
