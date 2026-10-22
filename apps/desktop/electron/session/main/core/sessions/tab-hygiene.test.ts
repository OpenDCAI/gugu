import { describe, expect, it } from 'vitest';
import { TAB_HYGIENE_THRESHOLD, tabHygiene } from './tab-hygiene';

const tabs = (count: number) => Array.from({ length: count }, (_, n) => ({ tab_id: `t-${n}`, title: `Report ${n}`, kind: 'file', closable: true }));

describe('open tab hygiene', () => {
  it('starts at five live tabs and gives ids, titles, both catalog calls and preference precedence', () => {
    expect(TAB_HYGIENE_THRESHOLD).toBe(5);
    expect(tabHygiene(tabs(4))).toEqual({ tab_count: 4 });
    const result = tabHygiene(tabs(5));
    expect(result.tab_count).toBe(5);
    expect(result.tabs).toEqual(tabs(5));
    expect(result.note).toContain('5 open tabs');
    expect(result.note).toContain('conversation or your memory');
    expect(result.note).toContain('tab limit, or no limit');
    expect(result.note).toContain('Otherwise, close finished supplementary tabs');
    expect(result.note).toContain('catalog_call({tool:"session_close_tab",args:{tab_id:"<id>"}})');
    expect(result.note).toContain('session_list_tabs');
    expect(tabHygiene(tabs(6)).note).toContain('6 open tabs');
  });

  it('does not invent a count for queued opens or older viewers with no live acknowledgement', () => {
    expect(tabHygiene(undefined)).toEqual({});
    expect(tabHygiene([])).toEqual({ tab_count: 0 });
  });
});
