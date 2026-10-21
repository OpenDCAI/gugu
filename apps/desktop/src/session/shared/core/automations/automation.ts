import type { AgentConfig, TriggerConfig, StoredAutomationSessionConfig } from './config';

export type Automation = {
  id: string;
  projectId?: string;
  name: string;
  triggerConfig?: TriggerConfig;
  agentConfig?: AgentConfig;
  sessionConfig?: StoredAutomationSessionConfig;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * #7221 agent 给自己排的:到点不新开会话,把 `agentConfig.prompt` 原样送回这条会话(同一身份、同一段对话)。
   * 缺席 = 人建的那种,到点新开会话。
   */
  agentSessionId?: string;
  /** 建它的那个 agent,给界面标「谁建的」;只在 `agentSessionId` 有值时有。`gone` = 那条会话已归档或删除。 */
  agentSession?: { name: string | null; gone: boolean };
};

/** #7221 一次性、那一刻已过、已经关了:不会再响,开关不再给打开(服务端同样拒:schedule_time_passed)。 */
export function isSpentOneTimeAutomation(automation: Automation, now = Date.now()): boolean {
  const at = automation.triggerConfig?.at;
  return !automation.enabled && at != null && at <= now;
}

export type CreateAutomationParams = {
  name: string;
  triggerConfig: TriggerConfig;
  agentConfig: AgentConfig;
  sessionConfig?: StoredAutomationSessionConfig;
  projectId: string;
  enabled?: boolean;
};

export type UpdateAutomationSettingsPatch = {
  projectId?: string;
  triggerConfig?: TriggerConfig;
  agentConfig?: AgentConfig;
  sessionConfig?: StoredAutomationSessionConfig | null;
};
