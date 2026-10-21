import { type AutomationRunRow } from '@main/db/schema';
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTriggerKind,
  RunError,
} from '@shared/core/automations/automation-run';
import {
  automationAgentConfig,
  automationTriggerConfig,
  storedAutomationSessionConfig,
} from '@shared/core/automations/config';

function parseRunError(raw: string | null | undefined): RunError | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'step' in parsed &&
      'code' in parsed &&
      typeof (parsed as RunError).step === 'string' &&
      typeof (parsed as RunError).code === 'string'
    ) {
      return parsed as RunError;
    }
  } catch {
    // fall through
  }
  return null;
}

export function mapAutomationRunRowToAutomationRun(
  row: AutomationRunRow,
  sessionId: string | null = null
): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    status: row.status as AutomationRunStatus,
    triggerKind: row.triggerKind as AutomationRunTriggerKind,
    triggerConfigSnapshot: automationTriggerConfig.parseJson(row.triggerConfigSnapshot) ?? {
      expr: '',
    },
    agentConfigSnapshot: automationAgentConfig.parseJson(
      row.agentConfigSnapshot
    ) ?? {
      prompt: '',
      provider: '',
      autoApprove: false,
    },
    sessionConfigSnapshot: storedAutomationSessionConfig.parseJson(row.sessionConfigSnapshot),
    scheduledAt: row.scheduledAt,
    deadlineAt: row.deadlineAt,
    startedAt: row.startedAt,
    sessionCreatedAt: row.sessionCreatedAt,
    launchedAt: row.launchedAt,
    finishedAt: row.finishedAt,
    sessionId,
    generatedSessionName: row.generatedSessionName ?? null,
    error: parseRunError(row.error),
  };
}
