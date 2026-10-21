import { buildSystemNoticeEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope';
import { decodeTypedId, encodeTypedId } from '@gugu/core/shared/typedId.mjs';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { automationsService, type AutomationsService } from './automations-service';
import { getAutomation, listAgentSchedules } from './repo';
import { describeScheduleTime, resolveScheduleTrigger } from './schedule-time';

/**
 * #7221 agent 的 schedule_* 工具:在它自己所在的这台机器上,给**自己**建、看、取消「已安排」。
 * 只能给自己排 —— 没有「目标会话」这个参数,送回的永远是发起调用的那条会话。
 */
export type AgentScheduleAction =
  | { action: 'schedule_create'; prompt: string; title?: string; at?: string; cron?: string; tz?: string }
  | { action: 'schedule_list' }
  | { action: 'schedule_cancel'; schedule_id: string };

export type AgentScheduleCaller = { sessionId: string; projectId: string; provider: string | null };

/** 一条会话同时开着的上限:一个打转的 agent 不该在主人的列表里排出几百条。 */
export const MAX_ACTIVE_SCHEDULES_PER_SESSION = 50;

const TITLE_MAX = 40;

function defaultTitle(prompt: string): string {
  const firstLine = prompt.trim().split('\n', 1)[0]!.trim();
  return [...firstLine].length > TITLE_MAX ? `${[...firstLine].slice(0, TITLE_MAX).join('')}…` : firstLine;
}

type ScheduleRow = {
  schedule_id: string;
  title: string;
  prompt: string;
  /** 一次性:那一刻;重复:null。 */
  at: string | null;
  /** 重复:cron;一次性:null。 */
  cron: string | null;
  tz: string | null;
  /** 还会不会响:关掉了(人在列表上停的,或一次性的已经跑过)就是 false。 */
  active: boolean;
  next_run_at: string | null;
  last_run: { status: string; at: string | null; error?: string } | null;
};

function scheduleRow(
  automation: Automation,
  next: AutomationRun | null,
  last: AutomationRun | null
): ScheduleRow {
  const trigger = automation.triggerConfig;
  const tz = trigger?.tz ?? null;
  const lastAt = last ? (last.finishedAt ?? last.startedAt ?? last.scheduledAt) : null;
  return {
    schedule_id: encodeTypedId('schedule', automation.id),
    title: automation.name,
    prompt: automation.agentConfig?.prompt ?? '',
    at: trigger?.at != null ? describeScheduleTime(trigger.at, tz ?? undefined) : null,
    cron: trigger && trigger.at == null ? trigger.expr : null,
    tz,
    active: automation.enabled,
    next_run_at:
      automation.enabled && next?.scheduledAt != null
        ? describeScheduleTime(next.scheduledAt, tz ?? undefined)
        : null,
    last_run: last
      ? {
          status: last.status,
          at: lastAt != null ? describeScheduleTime(lastAt, tz ?? undefined) : null,
          ...(last.error ? { error: last.error.message ?? last.error.code } : {}),
        }
      : null,
  };
}

async function rowOf(service: AutomationsService, automation: Automation): Promise<ScheduleRow> {
  const [next, last] = await Promise.all([
    service.getNextScheduledRun(automation.id),
    service.getLatestRun(automation.id),
  ]);
  return scheduleRow(automation, next, last);
}

export async function runAgentScheduleAction(
  caller: AgentScheduleCaller,
  action: AgentScheduleAction,
  service: AutomationsService = automationsService
): Promise<unknown> {
  if (action.action === 'schedule_create') {
    const prompt = typeof action.prompt === 'string' ? action.prompt.trim() : '';
    if (!prompt) throw new Error('prompt is required: what to tell yourself when it is due');
    const triggerConfig = resolveScheduleTrigger({ at: action.at, cron: action.cron, tz: action.tz });
    const active = (await listAgentSchedules(caller.sessionId)).filter((entry) => entry.enabled);
    if (active.length >= MAX_ACTIVE_SCHEDULES_PER_SESSION) {
      throw new Error(
        `you already have ${active.length} active schedules (the limit is ${MAX_ACTIVE_SCHEDULES_PER_SESSION}); cancel some with schedule_cancel first`
      );
    }
    const { automation, nextRun } = await service.createAgentSchedule({
      agentSessionId: caller.sessionId,
      projectId: caller.projectId,
      name: action.title?.trim() || defaultTitle(prompt),
      prompt,
      provider: caller.provider ?? 'unknown',
      triggerConfig,
    });
    return scheduleRow(automation, nextRun, null);
  }

  if (action.action === 'schedule_list') {
    const list = await listAgentSchedules(caller.sessionId);
    return { schedules: await Promise.all(list.map((automation) => rowOf(service, automation))) };
  }

  if (action.action === 'schedule_cancel') {
    const id = decodeTypedId('schedule', action.schedule_id, 'schedule_id');
    const automation = await getAutomation(id);
    // 别人的与不存在的同一个答案:不告诉这个 agent 别的会话排了什么。
    if (!automation || automation.agentSessionId !== caller.sessionId) {
      throw new Error(`no schedule ${action.schedule_id} of yours — schedule_list shows the ones you set`);
    }
    await service.deleteAutomation(id);
    return { schedule_id: action.schedule_id, cancelled: true };
  }

  throw new Error(`unknown schedule action ${JSON.stringify((action as { action?: unknown }).action)}`);
}

/** #7199 助理搬家:要在新家重排的一条「已安排」(来自旧家那台的 `listAutomations`,只取到点要用的这几样)。 */
export type RestorableSchedule = {
  name: string;
  prompt: string;
  triggerConfig: NonNullable<Automation['triggerConfig']>;
  enabled: boolean;
};

export type RestoreSchedulesResult = {
  restored: number;
  skipped: { name: string; reason: 'exists' | 'never-fires' | 'empty-prompt' }[];
};

type RestoreDeps = {
  service: Pick<AutomationsService, 'createAgentSchedule' | 'setAutomationEnabled'>;
  list: (agentSessionId: string) => Promise<Automation[]>;
};

/**
 * 把搬走的助理在旧家排的「已安排」在这台机器、这位助理的会话上重排一遍。
 * 幂等:同一条(交代 + 触发时刻都一样)已经在了就不再排 —— 搬到一半断了重来不会翻倍。
 * 一次性的已过了点 = 永远不会响,不排、写进 skipped(❌ 排一条永远不响的让人以为排上了)。
 */
export async function restoreAgentSchedules(
  target: AgentScheduleCaller,
  schedules: readonly RestorableSchedule[],
  deps: RestoreDeps = { service: automationsService, list: listAgentSchedules }
): Promise<RestoreSchedulesResult> {
  const existing = await deps.list(target.sessionId);
  const key = (prompt: string, trigger: RestorableSchedule['triggerConfig'] | null) =>
    JSON.stringify([prompt.trim(), trigger?.at ?? null, trigger?.expr ?? null, trigger?.tz ?? null]);
  const have = new Set(existing.map((entry) => key(entry.agentConfig?.prompt ?? '', entry.triggerConfig ?? null)));
  const result: RestoreSchedulesResult = { restored: 0, skipped: [] };
  for (const schedule of schedules) {
    if (!schedule.prompt.trim()) {
      result.skipped.push({ name: schedule.name, reason: 'empty-prompt' });
      continue;
    }
    if (have.has(key(schedule.prompt, schedule.triggerConfig))) {
      result.skipped.push({ name: schedule.name, reason: 'exists' });
      continue;
    }
    try {
      const { automation } = await deps.service.createAgentSchedule({
        agentSessionId: target.sessionId,
        projectId: target.projectId,
        name: schedule.name,
        prompt: schedule.prompt,
        provider: target.provider ?? 'unknown',
        triggerConfig: schedule.triggerConfig,
      });
      if (!schedule.enabled) await deps.service.setAutomationEnabled(automation.id, false);
      have.add(key(schedule.prompt, schedule.triggerConfig));
      result.restored += 1;
    } catch (error) {
      if (error instanceof Error && error.message === 'schedule_never_fires') {
        result.skipped.push({ name: schedule.name, reason: 'never-fires' });
        continue;
      }
      throw error;
    }
  }
  return result;
}

/** 人在界面上动了 agent 排的那条(取消、改时间、停掉 / 重新打开)之后,要告诉它的那一句。 */
export type AgentScheduleChange =
  | { kind: 'cancelled'; automation: Automation }
  | { kind: 'paused'; automation: Automation }
  | { kind: 'rescheduled' | 'resumed'; automation: Automation; nextRunAt: number | null };

export type AgentScheduleNotifyDeps = {
  /** 存下来、不叫醒,它下一次开始干活时一起送进去(`session_message` 的 defer 那一档)。 */
  defer(sessionId: string, envelope: (messageId: string, text: string) => string, text: string, keyScope: string): Promise<unknown>;
};

const defaultNotifyDeps: AgentScheduleNotifyDeps = {
  async defer(sessionId, envelope, text, keyScope) {
    // 动态取:与到点送回同一条投递(deliverToAgent),调度器的单测不为会话编排那一整套付代价。
    const { messageSessionFrom } = await import('@main/core/sessions/session-orchestration');
    return messageSessionFrom(envelope, sessionId, text, { keyScope, delivery: 'defer', key: 'changed' });
  },
};

/** 告诉 agent 的那一句(英文,与它收到的其它系统事实同一种口吻);带 schedule id,它要再改就用得上。 */
export function agentScheduleChangeText(change: AgentScheduleChange): string {
  const { automation } = change;
  const id = encodeTypedId('schedule', automation.id);
  if (change.kind === 'cancelled') {
    return `The person cancelled your schedule "${automation.name}" (${id}). It will not come back.`;
  }
  if (change.kind === 'paused') {
    return `The person paused your schedule "${automation.name}" (${id}). It will not come back unless they turn it on again.`;
  }
  const trigger = automation.triggerConfig;
  const tz = trigger?.tz ?? undefined;
  const next = change.nextRunAt != null ? describeScheduleTime(change.nextRunAt, tz) : null;
  if (change.kind === 'resumed') {
    return `The person turned your schedule "${automation.name}" (${id}) back on${next ? `; next ${next}` : ''}.`;
  }
  const when =
    trigger?.at != null
      ? `to ${describeScheduleTime(trigger.at, tz)}`
      : `to repeat on cron "${trigger?.expr ?? ''}"${next ? `, next ${next}` : ''}`;
  return `The person moved your schedule "${automation.name}" (${id}) ${when}. What it asks you to do is unchanged.`;
}

/**
 * owner 10-19 B:人取消了、或改了 agent 排的那条的时间,告诉它 —— ❌ 叫醒它(起一个回合就要花额度),
 * 存着等它下一次干活时一起送进去。同一条再动一次,替换掉还没送出去的那一句(key 按这一条定时)。
 * 只在人那条路上调(controller):agent 自己 schedule_cancel 不必告诉它自己。
 */
export async function tellAgentScheduleChanged(
  change: AgentScheduleChange,
  deps: AgentScheduleNotifyDeps = defaultNotifyDeps
): Promise<void> {
  const sessionId = change.automation.agentSessionId;
  if (!sessionId) return;
  const text = agentScheduleChangeText(change);
  await deps.defer(
    sessionId,
    (messageId, said) =>
      buildSystemNoticeEnvelope({ messageId, content: said, at: formatDeliveryTimestamp(new Date().toISOString()) }),
    text,
    `automation:${change.automation.id}`
  );
}
