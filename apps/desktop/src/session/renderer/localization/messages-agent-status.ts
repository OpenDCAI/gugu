import enUSCommon from '@/i18n/locales/en-US/common';
import zhCNCommon from '@/i18n/locales/zh-CN/common';
import {
  AGENT_STATUS_LABELS,
  type AgentStatusLabel,
} from '@gugu/core/shared/agentStatusPresentation';

/**
 * agent 状态那一句在会话页的文案目录里的样子。#6448 owner 2026-09-25:会话页、聊天、手机说同一张表 ——
 * ⇒ 这里**不另写一份**词,直接从咕咕 i18next 的 `common:agentStatus.*` 取(聊天、手机读的就是它)。
 * 两套目录的 key 同名(`agentStatus.<label>`),类型上要求 14 个 label 一个不缺,少一个编译就红。
 */
type AgentStatusMessageKey = `agentStatus.${AgentStatusLabel}`;

function agentStatusMessages(
  table: Readonly<Record<AgentStatusLabel, string>>
): Record<AgentStatusMessageKey, string> {
  const messages = {} as Record<AgentStatusMessageKey, string>;
  for (const label of AGENT_STATUS_LABELS) messages[`agentStatus.${label}`] = table[label];
  return messages;
}

export const enUSAgentStatusMessages = agentStatusMessages(enUSCommon.agentStatus);

export const zhCNAgentStatusMessages: Record<AgentStatusMessageKey, string> = agentStatusMessages(
  zhCNCommon.agentStatus
);
