import { observer } from 'mobx-react-lite';
import { SessionsPanel } from './sessions-panel';

/** Visibility is managed by PaneContent so PTY sessions survive tab switches. */
export const TabContent = observer(function SessionTabContent() {
  return <SessionsPanel />;
});
