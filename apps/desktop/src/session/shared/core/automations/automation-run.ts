import type { AgentConfig, StoredAutomationSessionConfig, TriggerConfig } from './config';

export type AutomationRunStatus =
  | 'scheduled' // future cron slot, not yet due
  | 'queued' // due, awaiting a free slot
  | 'creating_session' // step 1 in progress
  | 'launching_session' // step 2 in progress (sessionId + sessionCreatedAt set)
  | 'starting_agent' // step 3 in progress (launchedAt set)
  | 'done'
  | 'failed'
  | 'skipped';

export type AutomationRunTriggerKind = 'cron' | 'manual';

export type RunError = {
  /** `deliver`:agent 给自己排的那一类(#7221)把交代送回它的会话。 */
  step: 'queue' | 'create_session' | 'launch_session' | 'start_agent' | 'deliver';
  code: string;
  message?: string; // supplementary context (branch name, timeout ms, etc.)
};

export type AutomationRun = {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  triggerKind: AutomationRunTriggerKind;
  triggerConfigSnapshot: TriggerConfig;
  agentConfigSnapshot: AgentConfig;
  sessionConfigSnapshot: StoredAutomationSessionConfig | null;
  scheduledAt: number | null;
  deadlineAt: number | null;
  startedAt: number | null;
  sessionCreatedAt: number | null; // written when creating_session → launching_session
  launchedAt: number | null; // written when launching_session → starting_agent
  finishedAt: number | null;
  /** 这次运行建出来的会话。 */
  sessionId: string | null;
  generatedSessionName: string | null;
  error: RunError | null;
};
