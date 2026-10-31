import { Command } from 'cmdk';
import { GitBranch } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { sessionAgentStatus, sessionAgentStatusDetail } from '@renderer/features/sessions/stores/session-selectors';
import type { SessionPageStore } from '@renderer/features/sessions/stores/session-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

export const PaletteSessionItem = observer(function PaletteSessionItem({
  sessionPageStore,
  value,
  onSelect,
}: {
  sessionPageStore: SessionPageStore;
  value: string;
  onSelect: () => void;
}) {
  const status = sessionAgentStatus(sessionPageStore);
  const detail = sessionAgentStatusDetail(sessionPageStore);

  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      <GitBranch size={14} className="shrink-0 text-foreground/40" />
      <span className="flex-1 truncate">{sessionPageStore.displayName}</span>
      <AgentStatusIndicator status={status} detail={detail} disableTooltip />
    </Command.Item>
  );
});
