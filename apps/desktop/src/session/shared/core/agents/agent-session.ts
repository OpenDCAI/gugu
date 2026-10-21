import type { AgentProviderId } from '@gugu/session-plugins/agents';

export interface AgentSessionConfig {
  sessionId: string;
  providerId: AgentProviderId;
  command: string;
  args: string[];
  cwd: string;
  providerSessionId?: string;
  shellSetup?: string;
  tmuxEnabled?: boolean;
  tmuxSessionName?: string;
  autoApprove: boolean;
  resume: boolean;
}
