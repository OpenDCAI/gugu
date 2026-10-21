import { createRPCController } from '@shared/lib/ipc/rpc';
import type { UpdateAutomationSettingsPatch } from '@shared/core/automations/automation';
import { log } from '@main/lib/logger';
import {
  restoreAgentSchedules,
  tellAgentScheduleChanged,
  type AgentScheduleCaller,
  type AgentScheduleChange,
  type RestorableSchedule,
} from './agent-schedules';
import { automationsService } from './automations-service';
import { getAutomation, listSessionSchedules } from './repo';

/**
 * 这个控制器是**人**那条路(「已安排」页、任务页的托盘、手机);agent 自己的 schedule_* 走会话分派器,不经过这里。
 * 所以人动了 agent 排的那条(取消、改时间),在这里告诉它(owner 10-19 B)。通知没存进去不回滚人的操作 —— 那一下已经做成了,
 * 响亮记日志。
 */
async function tellAgent(change: AgentScheduleChange): Promise<void> {
  try {
    await tellAgentScheduleChanged(change);
  } catch (error) {
    log.error('automations: could not tell the agent its schedule changed', {
      automationId: change.automation.id,
      kind: change.kind,
      error: String(error),
    });
  }
}

/** 人停掉 / 重新打开 agent 排的那条:与取消、改时间同一个道理,它要知道这条还会不会回来。 */
async function setEnabledAndTell(id: string, enabled: boolean): Promise<void> {
  const before = await getAutomation(id);
  await automationsService.setAutomationEnabled(id, enabled);
  if (!before?.agentSessionId || before.enabled === enabled) return;
  const automation = await getAutomation(id);
  if (!automation) return;
  const next = enabled ? await automationsService.getNextScheduledRun(id) : null;
  await tellAgent(enabled ? { kind: 'resumed', automation, nextRunAt: next?.scheduledAt ?? null } : { kind: 'paused', automation });
}

export const automationsController = createRPCController({
  listAutomations: automationsService.listAutomations.bind(automationsService),
  createAutomation: automationsService.createAutomation.bind(automationsService),
  updateAutomationSettings: async (id: string, patch: UpdateAutomationSettingsPatch) => {
    const before = await getAutomation(id);
    const automation = await automationsService.updateAutomationSettings(id, patch);
    // 真改了、而且它还开着才说:原样保存不算改;停着的那条它本来就不指望回来,重新开的时候再说(见下)。
    const moved = JSON.stringify(before?.triggerConfig ?? null) !== JSON.stringify(automation.triggerConfig ?? null);
    if (automation.agentSessionId && automation.enabled && moved) {
      const next = await automationsService.getNextScheduledRun(id);
      await tellAgent({ kind: 'rescheduled', automation, nextRunAt: next?.scheduledAt ?? null });
    }
    return automation;
  },
  renameAutomation: automationsService.renameAutomation.bind(automationsService),
  setAutomationEnabled: (id: string, enabled: boolean) => setEnabledAndTell(id, enabled),
  toggleAutomationEnabled: (id: string, enabled: boolean) => setEnabledAndTell(id, enabled),
  listAutomationRuns: automationsService.listAutomationRuns.bind(automationsService),
  countAutomationRunsByStatus:
    automationsService.countAutomationRunsByStatus.bind(automationsService),
  getLatestRun: automationsService.getLatestRun.bind(automationsService),
  getNextScheduledRun: automationsService.getNextScheduledRun.bind(automationsService),
  runAutomation: automationsService.runAutomation.bind(automationsService),
  stopRun: automationsService.stopRun.bind(automationsService),
  getRun: automationsService.getRun.bind(automationsService),
  deleteAutomation: async (id: string) => {
    const automation = await getAutomation(id);
    // 只有本来还会响的那条才要告诉它:过了点、没送到的那条点「不用了」,它那边本来就不会再回来。
    const pending =
      automation?.agentSessionId && automation.enabled ? await automationsService.getNextScheduledRun(id) : null;
    await automationsService.deleteAutomation(id);
    if (automation && pending) await tellAgent({ kind: 'cancelled', automation });
  },
  /** 这台机器上每条会话给自己排的定时里,任务页要给人看的那些(行上的时钟、输入框上方的托盘)。 */
  listSessionSchedules: async () => listSessionSchedules(),

  /**
   * #7199 助理搬家:把旧家那台上它给自己排的「已安排」在这台机器、它这条会话上重排。
   * 幂等(同一条已在就不再排),一次性且已过点的不排并如实回报。
   */
  restoreAgentSchedules: async (target: AgentScheduleCaller, schedules: RestorableSchedule[]) =>
    restoreAgentSchedules(target, schedules),
});
