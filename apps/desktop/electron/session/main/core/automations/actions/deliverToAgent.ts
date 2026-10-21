import { err, ok, type Result } from '@gugu/session-shared';
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs';
import {
  buildScheduledEnvelope,
  formatDeliveryTimestamp,
} from '@gugu/core/local/agent/deliveryEnvelope';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { markRunDone, markRunFailed, type OnStepCompleted } from '../run-transitions';
import { describeScheduleTime } from '../schedule-time';

/**
 * #7221 agent 给自己排的那一类到点:把当初那句交代原样送回建它的那条会话 —— 同一身份、同一段对话,
 * 结果因此落在用户原来那条私聊里。❌ 新开会话。
 *
 * 送法与 `session_message` 的 `session:` 腿是同一条投递(`messageSessionFrom`):会话进程停着就先带着
 * 历史接回来再送。会话已归档或删除 = 建它的 agent 已不在:这次记为失败并写明原因,❌ 悄悄吞掉。
 */
export type AgentScheduleDeliveryDeps = {
  /** 这条会话在这台机器上、没归档。 */
  sessionPresent(sessionId: string): Promise<boolean>;
  /** 送进去,停着的先恢复;送不到就抛,带原因。 */
  deliver(
    sessionId: string,
    envelope: (messageId: string, text: string) => string,
    text: string,
    keyScope: string
  ): Promise<{ id: string }>;
};

const defaultDeps: AgentScheduleDeliveryDeps = {
  async sessionPresent(sessionId) {
    const [row] = await db
      .select({ archivedAt: sessions.archivedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return !!row && row.archivedAt == null;
  },
  async deliver(sessionId, envelope, text, keyScope) {
    // 动态取:会话编排拖着整套会话页运行时,调度器的单测不该为它付代价。
    const { messageSessionFrom } = await import('@main/core/sessions/session-orchestration');
    return messageSessionFrom(envelope, sessionId, text, { keyScope });
  },
};

/** 投递信封里那一格「原定几点、重不重复、要取消用哪个 id」(标题在信封自己那一格 `schedule`):agent 据此知道是自己排的。 */
export function agentScheduleContext(automation: Automation, run: AutomationRun): string {
  const trigger = run.triggerConfigSnapshot;
  const when = run.scheduledAt != null ? describeScheduleTime(run.scheduledAt, trigger.tz) : 'now';
  const repeat = trigger.at != null ? 'one-time' : `repeats on cron "${trigger.expr}"`;
  const how = run.triggerKind === 'manual' ? ', run by hand from the 已安排 list' : '';
  return `Your schedule ${encodeTypedId('schedule', automation.id)}, due ${when}, ${repeat}${how}.`;
}

export async function executeAgentDelivery(
  automation: Automation,
  run: AutomationRun,
  onStepCompleted: OnStepCompleted,
  deps: AgentScheduleDeliveryDeps = defaultDeps
): Promise<Result<AutomationRun, string>> {
  const sessionId = automation.agentSessionId;
  if (!sessionId) throw new Error('executeAgentDelivery: automation has no agent session');

  if (!(await deps.sessionPresent(sessionId))) {
    const failed = await markRunFailed(run.id, {
      step: 'deliver',
      code: 'agent_gone',
      message: 'the agent that set this schedule is gone (its session was archived or deleted)',
    });
    onStepCompleted(failed);
    return err('agent_gone');
  }

  const text = run.agentConfigSnapshot.prompt.trim() || automation.agentConfig?.prompt?.trim() || '';
  if (!text) {
    const failed = await markRunFailed(run.id, { step: 'deliver', code: 'no_prompt' });
    onStepCompleted(failed);
    return err('no_prompt');
  }

  const context = agentScheduleContext(automation, run);
  try {
    await deps.deliver(
      sessionId,
      (messageId, said) =>
        buildScheduledEnvelope({
          messageId,
          content: said,
          title: automation.name,
          context,
          at: formatDeliveryTimestamp(new Date().toISOString()),
        }),
      text,
      `automation:${automation.id}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Agent schedule delivery failed', {
      automationId: automation.id,
      runId: run.id,
      sessionId,
      error: message,
    });
    const failed = await markRunFailed(run.id, { step: 'deliver', code: 'delivery_failed', message });
    onStepCompleted(failed);
    return err(message);
  }

  const done = await markRunDone(run.id, Date.now());
  onStepCompleted(done);
  return ok(done);
}
