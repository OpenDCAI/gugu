import { err, ok, type Result } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { executeAgentDelivery } from './actions/deliverToAgent';
import { executeSessionCreate } from './actions/sessionCreate';
import { markRunDone, markRunSkipped, type OnStepCompleted } from './run-transitions';

export type { OnStepCompleted };

export type AutomationRunExecutor = (
  automation: Automation,
  run: AutomationRun,
  onStepCompleted: OnStepCompleted
) => Promise<Result<AutomationRun, string>>;

export async function runQueuedAutomation(
  automation: Automation,
  initialRun: AutomationRun,
  onStepCompleted: OnStepCompleted
): Promise<Result<AutomationRun, string>> {
  let run = initialRun;

  // #7221 agent 给自己排的:不开会话,把交代送回建它的那条会话。
  if (automation.agentSessionId) return executeAgentDelivery(automation, run, onStepCompleted);

  if (automation.projectId == null) {
    run = await markRunSkipped(run.id, { step: 'queue', code: 'no_project' });
    onStepCompleted(run);
    return err('no_project');
  }

  const prompt = automation.agentConfig?.prompt?.trim();
  if (!prompt) {
    log.warn('Automation run has no prompt in agentConfigSnapshot', {
      automationId: automation.id,
      runId: run.id,
    });
    run = await markRunSkipped(run.id, { step: 'queue', code: 'no_actions_configured' });
    onStepCompleted(run);
    return ok(run);
  }

  const result = await executeSessionCreate(automation, run, onStepCompleted).catch(
    (error): Result<string, string> => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  );

  if (!result.success) {
    log.error('Automation session create failed', {
      automationId: automation.id,
      runId: run.id,
      error: result.error,
    });
    // markRunFailed was already called inside executeSessionCreate
    return err(result.error);
  }

  run = await markRunDone(run.id, Date.now());
  onStepCompleted(run);
  return ok(run);
}
