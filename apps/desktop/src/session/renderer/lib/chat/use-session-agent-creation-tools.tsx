import type { ChatComposerProps, MentionItem } from '@gugu/session-ui/react/components';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import {
  agentCreationToolsFromDescriptors,
  LOCAL_AGENT_CREATION_TOOLS,
  type AgentCreationToolDescriptor,
  type LocalAgentCreationTool,
} from '@/lib/agentCreationTools';
import { useCallback, useEffect, useMemo, useState } from 'react';

type RenderMentionIcon = NonNullable<ChatComposerProps['renderMentionIcon']>;

function MentionAvatar({ id, name, role }: { id: string; name: string; role?: MentionItem['role'] | null }) {
  const identityId = id.replace(/^(?:aid|user):/, '');
  const identity = useAvatarIdentity(identityId);
  return <Avatar seed={identityId} name={name} avatarUrl={identity?.avatar}
    isAgent={role ? role === 'agent' : undefined} size={14} harnessBadge={false} still />;
}

/** The provider and initial task composer share the same Electron tool catalog. */
export function useSessionAgentCreationTools(): {
  tools: readonly LocalAgentCreationTool[];
  error: string | null;
  byEngine: ReadonlyMap<string, LocalAgentCreationTool>;
  renderMentionIcon: RenderMentionIcon;
} {
  const [tools, setTools] = useState<readonly LocalAgentCreationTool[]>(() =>
    typeof window !== 'undefined' && window.electronAPI ? [] : LOCAL_AGENT_CREATION_TOOLS,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const load = electron?.getAgentCreationTools
      ? electron
          .getAgentCreationTools()
          .then((raw) => agentCreationToolsFromDescriptors(raw as AgentCreationToolDescriptor[]))
      : Promise.resolve(LOCAL_AGENT_CREATION_TOOLS);
    let active = true;
    void load
      .then((next) => {
        if (!active) return;
        setTools(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const byEngine = useMemo(() => new Map<string, LocalAgentCreationTool>(tools.map((tool) => [tool.engine, tool])), [tools]);
  const renderMentionIcon = useCallback<RenderMentionIcon>(({ id, label, name, kind, role }) =>
    kind === 'custom' ? <MentionAvatar id={id} name={name ?? label} role={role} /> : null, []);
  return { tools, error, byEngine, renderMentionIcon };
}
