import { NewSessionPage } from '@renderer/features/sessions/new-session-page';
import { SessionTitlebar } from '@renderer/features/sessions/session-titlebar';

// The task tab opens on the same composer as the sidebar's "新建任务" action. Project setup
// remains reachable from the composer's project picker (and the sidebar project controls), but
// it no longer replaces the primary task on the first screen.
export const HomeMainPanel = NewSessionPage;

export const homeView = {
  TitlebarSlot: SessionTitlebar,
  MainPanel: HomeMainPanel,
};
