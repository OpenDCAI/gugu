import { observer } from 'mobx-react-lite';
import { AcpChatPanel } from './acp-chat-panel';

export const TabContent = observer(function SideChatTabContent() {
  return (
    <div className="h-full" data-testid="side-chat-workspace-content">
      <AcpChatPanel tabKind="side-chat" />
    </div>
  );
});
