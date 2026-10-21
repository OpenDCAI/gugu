import { Command } from 'cmdk';
import { useObserver } from 'mobx-react-lite';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import {
  asMounted,
  getProjectManagerStore,
} from '@renderer/features/projects/stores/project-selectors';
import { isRegistered, type SessionPageStore } from '@renderer/features/sessions/stores/session-store';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';
import { PaletteSessionItem } from './palette-session-item';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { GitBranch } from 'lucide-react';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { remoteAgentStatus } from '@renderer/features/sidebar/session-groups';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { formatSessionTitleForDisplay } from '@renderer/features/sessions/session-title-utils';
import type { AgentStatusView } from '@gugu/core/shared/agentStatus';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type NotificationItem =
  | { projectId: string; sessionPageStore: SessionPageStore }
  /** 别的机器上、还没挂的会话:来自会话目录(列出不挂载)。 */
  | { projectId: string; listed: { id: string; title: string; reading: AgentStatusView } };

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

interface PaletteNotificationsGroupProps {
  onClose: () => void;
  navigate: NavigateFnTyped;
}

export function PaletteNotificationsGroup({
  onClose,
  navigate,
}: PaletteNotificationsGroupProps) {
  const { translate } = useSessionMessages();
  const items = useObserver((): NotificationItem[] => {
    const result: NotificationItem[] = [];

    for (const projectStore of getProjectManagerStore().projects.values()) {
      const mounted = asMounted(projectStore);
      if (!mounted) continue;
      const pid = mounted.data.id;

      for (const [id, sessionPageStore] of mounted.sessionManager.sessions) {
        if (!isRegistered(sessionPageStore)) continue;
        const sessions = sessionRegistry.get(id);
        if (!sessions) continue;

        const status = sessions.sessionStatus;
        // Only surface needs_user and error — not working or idle.
        if (!status || status === 'idle' || status === 'working') continue;

        result.push({ projectId: pid, sessionPageStore });
      }
    }

    for (const projectStore of getProjectManagerStore().projects.values()) {
      if (asMounted(projectStore)) continue;
      const machine = machineRegistry.machineOf(projectStore.id);
      if (!machine) continue;
      const { sessions, live } = remoteHostsStore.sessionsOf(machine);
      for (const summary of sessions) {
        if (summary.projectId !== projectStore.id) continue;
        const reading = remoteAgentStatus(summary, live);
        if (!reading || reading.status === 'idle' || reading.status === 'working') continue;
        const title = formatSessionTitleForDisplay(summary.harness, summary.title);
        result.push({ projectId: projectStore.id, listed: { id: summary.conversationId, title, reading } });
      }
    }

    return result;
  });

  if (items.length === 0) return null;

  return (
    <Command.Group heading={translate('palette.notifications')} className={GROUP_CLASS}>
      {items.map((item) => {
        if ('listed' in item) {
          const { listed } = item;
          return (
            <Command.Item
              key={listed.id}
              value={`notif:session:${listed.id}`}
              onSelect={() => {
                navigate('session', { projectId: item.projectId, sessionId: listed.id });
                onClose();
              }}
              className={PALETTE_ITEM_CLASS}
            >
              <GitBranch size={14} className="shrink-0 text-foreground/40" />
              <span className="flex-1 truncate">{listed.title}</span>
              <AgentStatusIndicator status={listed.reading.status} detail={listed.reading.detail} disableTooltip />
            </Command.Item>
          );
        }
        return (
          <PaletteSessionItem
            key={item.sessionPageStore.data.id}
            sessionPageStore={item.sessionPageStore}
            value={`notif:session:${item.sessionPageStore.data.id}`}
            onSelect={() => {
              navigate('session', {
                projectId: item.projectId,
                sessionId: item.sessionPageStore.data.id,
              });
              onClose();
            }}
          />
        );
      })}
    </Command.Group>
  );
}
