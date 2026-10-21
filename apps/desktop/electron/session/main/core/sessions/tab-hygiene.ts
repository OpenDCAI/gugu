import type { SessionPaneTab } from '@gugu/session-core/session-record/contract';

export const TAB_HYGIENE_THRESHOLD = 5;
export type TabHygieneResult = { tab_count?: number; tabs?: SessionPaneTab[]; note?: string };

/** Only a live acknowledgement can supply this state; queued opens have none. */
export function tabHygiene(tabs: SessionPaneTab[] | undefined): TabHygieneResult {
  if (!tabs) return {};
  return {
    tab_count: tabs.length,
    ...(tabs.length < TAB_HYGIENE_THRESHOLD ? {} : {
      tabs,
      note: `This task has ${tabs.length} open tabs. Follow any tab limit, or no limit, the user explicitly stated in the conversation or your memory. Otherwise, close finished supplementary tabs with catalog_call({tool:"session_close_tab",args:{tab_id:"<id>"}}). Refresh with catalog_call({tool:"session_list_tabs",args:{}}).`,
    }),
  };
}
