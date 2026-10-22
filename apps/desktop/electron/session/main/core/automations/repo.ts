import { activitySignal } from '../activity/signals';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getPlugin, isValidProviderId } from '@main/core/agents/plugin-registry';
import { generateRandom } from '@main/core/sessions/name-generation/generateSessionName';
import { db } from '@main/db/client';
import {
  automationRuns,
  automations,
  projects,
  sessions,
  type AutomationRow,
  type AutomationRunRow,
} from '@main/db/schema';
import { log } from '@main/lib/logger';
import type {
  Automation,
  CreateAutomationParams,
  UpdateAutomationSettingsPatch,
} from '@shared/core/automations/automation';
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTriggerKind,
  RunError,
} from '@shared/core/automations/automation-run';
import type {
  AgentConfig,
  StoredAutomationSessionConfig,
  TriggerConfig,
} from '@shared/core/automations/config';
import { storedAutomationSessionConfig } from '@shared/core/automations/config';
import { getLocalTimeZone } from '@shared/core/automations/timezone';
import {
  compareSessionSchedules,
  MISSED_RUN_CODES,
  scheduleShown,
  type SessionSchedule,
} from '@shared/core/automations/session-schedule';
import { assertValidCronTrigger } from '@shared/core/automations/validation';
import { assertTimeZone, MIN_ONE_TIME_LEAD_MS } from './schedule-time';

function observeRun(run: AutomationRun | null, at = Date.now()): AutomationRun | null {
  if (run) activitySignal({ event_id: `automation.run:${run.id}:${run.status}`, kind: 'automation.run',
    object_id: run.id, status: run.status, occurred_at: at,
    ...(run.sessionId ? { session_id: run.sessionId } : {}) });
  return run;
}

const DEFAULT_TZ = getLocalTimeZone();

export function assertValidAutomationInput(input: {
  triggerConfig: TriggerConfig;
  agentConfig: AgentConfig;
}): void {
  assertValidCronTrigger(input.triggerConfig);
  if (input.triggerConfig.at != null) throw new Error('cron_invalid');
  if (!input.agentConfig.prompt.trim()) {
    throw new Error('agent_config_prompt_required');
  }
  const { autoApprove, provider } = input.agentConfig;
  if (!autoApprove) throw new Error('automation_auto_approve_required');
  if (
    !isValidProviderId(provider) ||
    getPlugin(provider).capabilities.autoApprove.kind !== 'supported'
  ) {
    throw new Error('automation_provider_unattended_access_unsupported');
  }
}

const RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  'scheduled',
  'queued',
  'creating_session',
  'launching_session',
  'starting_agent',
  'done',
  'failed',
  'skipped',
]);
const RUN_TRIGGER_KINDS: ReadonlySet<AutomationRunTriggerKind> = new Set(['cron', 'manual']);

function asRunStatus(value: string, runId: string): AutomationRunStatus {
  if (RUN_STATUSES.has(value as AutomationRunStatus)) return value as AutomationRunStatus;
  log.warn('automations.repo: invalid run status, falling back to failed', { runId, value });
  return 'failed';
}

function asRunTriggerKind(value: string, runId: string): AutomationRunTriggerKind {
  if (RUN_TRIGGER_KINDS.has(value as AutomationRunTriggerKind)) {
    return value as AutomationRunTriggerKind;
  }
  log.warn('automations.repo: invalid run trigger_kind, falling back to manual', { runId, value });
  return 'manual';
}

function mapAutomationRow(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId ?? undefined,
    triggerConfig: row.triggerConfig ?? undefined,
    agentConfig: row.agentConfig ?? undefined,
    sessionConfig: row.sessionConfig ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
  };
}

/**
 * #7221 给 agent 排的那几条补上「谁建的」:那条会话的名字(主人起的 agent 名,没有就是侧栏那个标题),
 * 会话已归档或删除就是 `gone`。读的是这台机器自己的会话表 —— 别的机器上看这台的「已安排」也是这台答。
 */
async function withAgentSessions(list: Automation[]): Promise<Automation[]> {
  const ids = [...new Set(list.flatMap((automation) => (automation.agentSessionId ? [automation.agentSessionId] : [])))];
  if (ids.length === 0) return list;
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      config: sessions.config,
      archivedAt: sessions.archivedAt,
    })
    .from(sessions)
    .where(inArray(sessions.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return list.map((automation) => {
    if (!automation.agentSessionId) return automation;
    const row = byId.get(automation.agentSessionId);
    const name = row ? row.config?.agentDisplayName?.trim() || row.title.trim() || null : null;
    return { ...automation, agentSession: { name, gone: !row || row.archivedAt != null } };
  });
}

function mapAutomationRowSafely(row: AutomationRow): Automation | null {
  try {
    return mapAutomationRow(row);
  } catch (error) {
    log.warn('automations.repo: skipping invalid automation row', {
      automationId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function mapAutomationRows(rows: AutomationRow[]): Automation[] {
  return rows.flatMap((row) => {
    const automation = mapAutomationRowSafely(row);
    return automation ? [automation] : [];
  });
}

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

function parseSnapshotTriggerConfig(raw: string, runId: string): TriggerConfig {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['expr'] === 'string'
    ) {
      return parsed as TriggerConfig;
    }
  } catch {
    // fall through
  }
  log.warn('automations.repo: invalid triggerConfigSnapshot, using empty', { runId });
  return { expr: '' };
}

function parseSnapshotSessionConfig(raw: string, runId: string): AgentConfig {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['prompt'] === 'string'
    ) {
      return parsed as AgentConfig;
    }
  } catch {
    // fall through
  }
  log.warn('automations.repo: invalid sessionConfigSnapshot, using empty', { runId });
  return { prompt: '', provider: '', autoApprove: false };
}

function mapAutomationRunRow(row: AutomationRunRow, sessionId: string | null = null): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    scheduledAt: row.scheduledAt,
    deadlineAt: row.deadlineAt,
    startedAt: row.startedAt,
    sessionCreatedAt: row.sessionCreatedAt,
    launchedAt: row.launchedAt,
    finishedAt: row.finishedAt,
    status: asRunStatus(row.status, row.id),
    sessionId,
    generatedSessionName: row.generatedSessionName ?? null,
    error: parseRunError(row.error),
    triggerKind: asRunTriggerKind(row.triggerKind, row.id),
    triggerConfigSnapshot: parseSnapshotTriggerConfig(row.triggerConfigSnapshot, row.id),
    agentConfigSnapshot: parseSnapshotSessionConfig(
      row.agentConfigSnapshot,
      row.id
    ),
    sessionConfigSnapshot: storedAutomationSessionConfig.parseJson(row.sessionConfigSnapshot),
  };
}

export function automationRunDeadline(
  automation: Automation,
  scheduledAt: number,
  triggerKind: AutomationRunTriggerKind
): number | null {
  if (triggerKind === 'cron' && automation.triggerConfig) {
    return getNextRunAt(automation.triggerConfig, scheduledAt);
  }
  return null;
}

export function getNextRunAt(
  trigger: TriggerConfig,
  from: number | Date = new Date()
): number | null {
  // 一次性的只有那一刻;过了就没有下一次。
  if (trigger.at != null) {
    return trigger.at > (from instanceof Date ? from.getTime() : from) ? trigger.at : null;
  }
  const next = new Cron(trigger.expr, { timezone: trigger.tz || DEFAULT_TZ }).nextRun(
    from instanceof Date ? from : new Date(from)
  );
  return next?.getTime() ?? null;
}

export async function listAutomations(projectId?: string): Promise<Automation[]> {
  const query = projectId
    ? db
        .select()
        .from(automations)
        .where(and(eq(automations.projectId, projectId), isNull(automations.deletedAt)))
    : db.select().from(automations).where(isNull(automations.deletedAt));
  const rows = await query;
  return withAgentSessions(mapAutomationRows(rows));
}

/** #7221 这条会话给自己排的(没删的),建得早的在前。 */
export async function listAgentSchedules(agentSessionId: string): Promise<Automation[]> {
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.agentSessionId, agentSessionId), isNull(automations.deletedAt)))
    .orderBy(asc(automations.createdAt));
  return mapAutomationRows(rows);
}

/**
 * 「最近一次」只认真跑过、或真没送到的那几种:送到了、失败了、错过了(MISSED_RUN_CODES)。人自己造成的跳过
 * (改了时间、停了、删了)不算 —— 否则改一下时间,上一次没送到的那个 ⚠ 就被一行 trigger_changed 冲掉了。
 */
const MEANINGFUL_LAST_RUN = or(
  inArray(automationRuns.status, ['done', 'failed']),
  and(
    eq(automationRuns.status, 'skipped'),
    inArray(sql`json_extract(${automationRuns.error}, '$.code')`, [...MISSED_RUN_CODES])
  )
);

/**
 * 这台机器上每条会话给自己排的定时里,任务页要给人看的那些(`scheduleShown`:还会回来的,与最近一次没送到的)。
 * 条目一问、各自排着的下一次一问;最近一次逐条按 (automation_id, scheduled_at) 索引倒着取一行 —— 条数是这台机器上
 * agent 排的定时(每条会话至多 50),不随运行历史长:一个每 5 分钟一次的 cron 攒了几万行也只读一行。
 * 同步读:会话列表(含离线心跳的摘要)是同步拼的,摘要里那一格从这里来。
 */
export function listSessionSchedules(now = Date.now()): SessionSchedule[] {
  const list = mapAutomationRows(
    db
      .select()
      .from(automations)
      .where(and(isNotNull(automations.agentSessionId), isNull(automations.deletedAt)))
      .all()
  );
  if (list.length === 0) return [];
  const ids = list.map((automation) => automation.id);

  const nextRunAt = new Map<string, number>();
  for (const row of db
    .select({
      automationId: automationRuns.automationId,
      at: sql<number>`min(${automationRuns.scheduledAt})`,
    })
    .from(automationRuns)
    .where(and(inArray(automationRuns.automationId, ids), eq(automationRuns.status, 'scheduled')))
    .groupBy(automationRuns.automationId)
    .all()) {
    if (row.at != null) nextRunAt.set(row.automationId, row.at);
  }

  const lastRun = new Map<string, SessionSchedule['lastRun']>();
  for (const id of ids) {
    const [run] = db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, id), MEANINGFUL_LAST_RUN))
      .orderBy(desc(automationRuns.scheduledAt))
      .limit(1)
      .all();
    if (!run) continue;
    lastRun.set(run.automationId, {
      status: run.status as 'done' | 'failed' | 'skipped',
      at: run.finishedAt ?? run.startedAt ?? run.scheduledAt,
      error: parseRunError(run.error),
    });
  }

  return list
    .flatMap((automation): SessionSchedule[] =>
      automation.agentSessionId && automation.triggerConfig
        ? [
            {
              id: automation.id,
              sessionId: automation.agentSessionId,
              title: automation.name,
              prompt: automation.agentConfig?.prompt ?? '',
              trigger: automation.triggerConfig,
              enabled: automation.enabled,
              nextRunAt: nextRunAt.get(automation.id) ?? null,
              lastRun: lastRun.get(automation.id) ?? null,
            },
          ]
        : []
    )
    .filter((schedule) => scheduleShown(schedule, now))
    .sort(compareSessionSchedules);
}

export async function getAutomation(id: string): Promise<Automation | null> {
  const [row] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
    .limit(1);
  const automation = row ? mapAutomationRowSafely(row) : null;
  if (!automation?.agentSessionId) return automation;
  return (await withAgentSessions([automation]))[0]!;
}

export async function skipQueuedCronRuns(
  automationId: string,
  code: string
): Promise<AutomationRun[]> {
  const error = JSON.stringify({ step: 'queue', code });
  const rows = await db
    .update(automationRuns)
    .set({ status: 'skipped', finishedAt: Date.now(), error })
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        inArray(automationRuns.status, ['scheduled', 'queued']),
        eq(automationRuns.triggerKind, 'cron')
      )
    )
    .returning();
  return rows.map((row) => mapAutomationRunRow(row));
}

async function projectExists(projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows.length > 0;
}

export async function createAutomation(input: CreateAutomationParams): Promise<Automation> {
  if (!(await projectExists(input.projectId))) {
    throw new Error('project_not_found');
  }

  assertValidAutomationInput({
    triggerConfig: input.triggerConfig,
    agentConfig: input.agentConfig,
  });

  const now = Date.now();
  const [row] = await db
    .insert(automations)
    .values({
      id: randomUUID(),
      name: input.name.trim(),
      triggerConfig: input.triggerConfig,
      agentConfig: input.agentConfig,
      sessionConfig: input.sessionConfig ?? null,
      projectId: input.projectId,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const automation = mapAutomationRow(row);
  if (automation.enabled) {
    await ensureNextCronRun(automation);
  }
  return automation;
}

/**
 * #7221 agent 给自己排一条:到点把 `prompt` 原样送回 `agentSessionId` 那条会话。只能给自己排 ——
 * 调用方(会话编排)传进来的就是发起调用的那条会话,这里不接受别的目标。
 * 和人建的一样,建好就预排下一次运行(`status='scheduled'` 那一行):云电脑管家睡前按它算几点叫醒。
 */
export async function createAgentSchedule(input: {
  agentSessionId: string;
  projectId: string;
  name: string;
  prompt: string;
  provider: string;
  triggerConfig: TriggerConfig;
}): Promise<{ automation: Automation; nextRun: AutomationRun | null }> {
  if (!input.prompt.trim()) throw new Error('agent_config_prompt_required');
  const now = Date.now();
  // 算不出下一次 = 这条永远不会响;建出来只会让人以为排上了。
  if (getNextRunAt(input.triggerConfig, now) == null) throw new Error('schedule_never_fires');
  const [row] = await db
    .insert(automations)
    .values({
      id: randomUUID(),
      name: input.name.trim(),
      triggerConfig: input.triggerConfig,
      // provider 只是记下是哪一家建的;到点不起新会话,也就用不到无人值守那一套。
      agentConfig: { prompt: input.prompt, provider: input.provider, autoApprove: false },
      sessionConfig: null,
      projectId: input.projectId,
      agentSessionId: input.agentSessionId,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const automation = mapAutomationRow(row);
  return { automation, nextRun: await ensureNextCronRun(automation, now) };
}

/**
 * 人给 agent 排的那条改时间时的判据,与它自己建的时候同一套:重复的要是能算出下一次的 cron;一次性的要在一分钟以后
 * (调度器一分钟扫一次,更近的排上了也只会晚到)。❌ 收下一个永远不会响的。
 */
function assertAgentScheduleTrigger(trigger: TriggerConfig, now = Date.now()): void {
  if (trigger.tz) assertTimeZone(trigger.tz);
  if (trigger.at != null) {
    if (trigger.at - now < MIN_ONE_TIME_LEAD_MS) throw new Error('schedule_too_soon');
    return;
  }
  assertValidCronTrigger(trigger);
  if (getNextRunAt(trigger, now) == null) throw new Error('schedule_never_fires');
}

export async function updateAutomationSettings(
  id: string,
  patch: UpdateAutomationSettingsPatch
): Promise<Automation | null> {
  if (patch.projectId !== undefined && !(await projectExists(patch.projectId))) {
    throw new Error('project_not_found');
  }

  return db.transaction((tx) => {
    const [existingRow] = tx
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
      .limit(1)
      .all();
    if (!existingRow) return null;

    const existing = mapAutomationRow(existingRow);
    // #7221 agent 排的那条:交代只归它自己的工具;界面上能停、能删、能改名,也能改时间(owner 10-19),别的不改。
    if (existing.agentSessionId) {
      const onlyTime =
        patch.triggerConfig !== undefined &&
        patch.agentConfig === undefined &&
        patch.sessionConfig === undefined &&
        patch.projectId === undefined;
      if (!onlyTime) throw new Error('agent_schedule_not_editable');
      assertAgentScheduleTrigger(patch.triggerConfig!);
      const [row] = tx
        .update(automations)
        .set({ triggerConfig: patch.triggerConfig, updatedAt: Date.now() })
        .where(eq(automations.id, id))
        .returning()
        .all();
      return row ? mapAutomationRow(row) : null;
    }
    const finalTriggerConfig = patch.triggerConfig ?? existing.triggerConfig;
    const finalSessionConfig = patch.agentConfig ?? existing.agentConfig;
    const finalProjectId = patch.projectId !== undefined ? patch.projectId : existing.projectId;

    if (finalTriggerConfig && finalSessionConfig) {
      assertValidAutomationInput({
        triggerConfig: finalTriggerConfig,
        agentConfig: finalSessionConfig,
      });
    }
    if (existing.enabled && finalProjectId == null) throw new Error('no_project_attached');

    const values: Partial<typeof automations.$inferInsert> = { updatedAt: Date.now() };
    if (patch.projectId !== undefined) values.projectId = patch.projectId;
    if (patch.triggerConfig !== undefined) {
      values.triggerConfig = patch.triggerConfig;
    }
    if (patch.agentConfig !== undefined) {
      values.agentConfig = patch.agentConfig;
    }
    if (patch.sessionConfig !== undefined) {
      values.sessionConfig = patch.sessionConfig ?? null;
    }

    const [row] = tx
      .update(automations)
      .set(values)
      .where(eq(automations.id, id))
      .returning()
      .all();
    return row ? mapAutomationRow(row) : null;
  });
}

export async function renameAutomation(id: string, name: string): Promise<Automation | null> {
  const [row] = await db
    .update(automations)
    .set({ name: name.trim(), updatedAt: Date.now() })
    .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
    .returning();
  return row ? mapAutomationRow(row) : null;
}

export async function softDeleteAutomation(id: string): Promise<boolean> {
  const rows = await db
    .update(automations)
    .set({ deletedAt: Date.now() })
    .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
    .returning({ id: automations.id });
  return rows.length > 0;
}

export async function setAutomationEnabled(
  id: string,
  enabled: boolean
): Promise<Automation | null> {
  const existing = await getAutomation(id);
  if (!existing) return null;
  // #7221 一次性的那一刻过了就不会再响:重新打开只会让列表显示「开着」而它永远不来,当场拒。
  if (enabled && existing.triggerConfig?.at != null && existing.triggerConfig.at <= Date.now()) {
    throw new Error('schedule_time_passed');
  }
  if (existing.projectId == null && !existing.agentSessionId && enabled) {
    throw new Error('no_project_attached');
  }
  const [row] = await db
    .update(automations)
    .set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
    .where(eq(automations.id, id))
    .returning();
  return row ? mapAutomationRow(row) : null;
}

const UNFINISHED_RUN_STATUSES: AutomationRunStatus[] = [
  'scheduled',
  'queued',
  'creating_session',
  'launching_session',
  'starting_agent',
];

/**
 * #7221 一次性的那一刻已过、也没有还没走完的运行 = 它不会再响了:关掉,列表与 schedule_list 都看得出来,
 * 也不再占「同时开着」的名额。跑完、被挤掉(previous_running)、重启时被打断,走到哪条都在这里收口。
 * 还有排着或在跑的运行时不动它 —— 那一次还要靠「开着」才会被调度。返回是否关了。
 */
export async function closeSpentOneTimeAutomation(
  automationId: string,
  now = Date.now()
): Promise<boolean> {
  const automation = await getAutomation(automationId);
  const at = automation?.triggerConfig?.at;
  if (!automation?.enabled || at == null || at > now) return false;
  const [unfinished] = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        inArray(automationRuns.status, UNFINISHED_RUN_STATUSES)
      )
    )
    .limit(1);
  if (unfinished) return false;
  await db
    .update(automations)
    .set({ enabled: 0, updatedAt: now })
    .where(and(eq(automations.id, automationId), eq(automations.enabled, 1)));
  return true;
}

export async function ensureNextCronRun(
  automation: Automation,
  from: number | Date = new Date()
): Promise<AutomationRun | null> {
  if (!automation.triggerConfig || !automation.agentConfig) return null;
  const scheduledAt = getNextRunAt(automation.triggerConfig, from);
  if (scheduledAt == null) return null;
  return scheduleAutomationRun({
    automationId: automation.id,
    triggerConfigSnapshot: automation.triggerConfig,
    agentConfigSnapshot: automation.agentConfig,
    sessionConfigSnapshot: automation.sessionConfig ?? null,
    scheduledAt,
    deadlineAt: getNextRunAt(automation.triggerConfig, scheduledAt),
    triggerKind: 'cron',
  });
}

/**
 * 人建的那种没项目就开不了会话,不排;agent 排的那种不开会话,项目没了照排 ——
 * 到点由投递那一步说清建它的会话还在不在(#7221)。
 */
const hasProjectOrAgent = sql`(${automations.projectId} IS NOT NULL OR ${automations.agentSessionId} IS NOT NULL)`;

export async function markDueCronRunsQueued(
  now = Date.now()
): Promise<Array<{ run: AutomationRun; automation: Automation }>> {
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .where(
      and(
        eq(automationRuns.status, 'scheduled'),
        eq(automationRuns.triggerKind, 'cron'),
        sql`${automationRuns.scheduledAt} <= ${now}`,
        eq(automations.enabled, 1),
        hasProjectOrAgent,
        isNull(automations.deletedAt)
      )
    )
    .orderBy(asc(automationRuns.scheduledAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.run.id);
  await db.update(automationRuns).set({ status: 'queued' }).where(inArray(automationRuns.id, ids));

  return rows.flatMap(({ run, automation }) => {
    const mappedAutomation = mapAutomationRowSafely(automation);
    return mappedAutomation
      ? [
          {
            run: observeRun({ ...mapAutomationRunRow(run), status: 'queued' as const }, now)!,
            automation: mappedAutomation,
          },
        ]
      : [];
  });
}

export async function enabledAutomationsWithoutQueuedRun(): Promise<Automation[]> {
  const rows = await db
    .select({ automation: automations })
    .from(automations)
    .leftJoin(
      automationRuns,
      and(
        eq(automationRuns.automationId, automations.id),
        inArray(automationRuns.status, ['scheduled', 'queued']),
        eq(automationRuns.triggerKind, 'cron')
      )
    )
    .where(
      and(
        eq(automations.enabled, 1),
        hasProjectOrAgent,
        isNull(automations.deletedAt),
        isNull(automationRuns.id)
      )
    );
  return rows.flatMap(({ automation }) => {
    const mapped = mapAutomationRowSafely(automation);
    return mapped ? [mapped] : [];
  });
}

export async function scheduleAutomationRun(input: {
  automationId: string;
  triggerConfigSnapshot: TriggerConfig;
  agentConfigSnapshot: AgentConfig;
  sessionConfigSnapshot: StoredAutomationSessionConfig | null;
  scheduledAt: number;
  deadlineAt: number | null;
  triggerKind: AutomationRunTriggerKind;
}): Promise<AutomationRun | null> {
  const runId = randomUUID();
  const generatedSessionName = generateRandom();
  const triggerSnap = JSON.stringify(input.triggerConfigSnapshot);
  const convSnap = JSON.stringify(input.agentConfigSnapshot);
  const sessionSnap = input.sessionConfigSnapshot ? JSON.stringify(input.sessionConfigSnapshot) : null;
  const rows = db.all<AutomationRunRow>(sql`
    INSERT INTO automation_runs (
      id, automation_id, scheduled_at, deadline_at, status, trigger_kind,
      trigger_config_snapshot, agent_config_snapshot, session_config_snapshot,
      generated_session_name
    )
    SELECT
      ${runId}, ${input.automationId}, ${input.scheduledAt}, ${input.deadlineAt},
      'scheduled', ${input.triggerKind},
      ${triggerSnap}, ${convSnap}, ${sessionSnap},
      ${generatedSessionName}
    WHERE NOT EXISTS (
      SELECT 1
      FROM automation_runs
      WHERE automation_id = ${input.automationId}
        AND scheduled_at = ${input.scheduledAt}
        AND trigger_kind = 'cron'
        AND status IN ('scheduled', 'queued')
    )
    RETURNING
      id,
      automation_id AS automationId,
      scheduled_at AS scheduledAt,
      deadline_at AS deadlineAt,
      started_at AS startedAt,
      session_created_at AS sessionCreatedAt,
      launched_at AS launchedAt,
      finished_at AS finishedAt,
      status,
      generated_session_name AS generatedSessionName,
      error,
      trigger_kind AS triggerKind,
      trigger_config_snapshot AS triggerConfigSnapshot,
      agent_config_snapshot AS agentConfigSnapshot,
      session_config_snapshot AS sessionConfigSnapshot
  `);
  return observeRun(rows[0] ? mapAutomationRunRow(rows[0]) : null);
}

export async function listQueuedRuns(limit = 100): Promise<
  Array<{
    run: AutomationRun;
    automation: Automation;
  }>
> {
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .where(
      and(
        eq(automationRuns.status, 'queued'),
        eq(automations.enabled, 1),
        isNull(automations.deletedAt)
      )
    )
    .orderBy(asc(automationRuns.scheduledAt), asc(automationRuns.startedAt))
    .limit(limit);
  return rows.flatMap(({ run, automation }) => {
    const mappedAutomation = mapAutomationRowSafely(automation);
    return mappedAutomation
      ? [{ run: mapAutomationRunRow(run), automation: mappedAutomation }]
      : [];
  });
}

export async function startCreatingSession(
  id: string,
  now = Date.now()
): Promise<AutomationRun | null> {
  const rows = db.all<AutomationRunRow>(sql`
    UPDATE automation_runs
    SET status = 'creating_session', started_at = ${now}
    WHERE id = ${id}
      AND status = 'queued'
    RETURNING
      id,
      automation_id AS automationId,
      scheduled_at AS scheduledAt,
      deadline_at AS deadlineAt,
      started_at AS startedAt,
      session_created_at AS sessionCreatedAt,
      launched_at AS launchedAt,
      finished_at AS finishedAt,
      status,
      error,
      trigger_kind AS triggerKind,
      trigger_config_snapshot AS triggerConfigSnapshot,
      agent_config_snapshot AS agentConfigSnapshot,
      session_config_snapshot AS sessionConfigSnapshot
  `);
  const [row] = rows;
  return observeRun(row ? mapAutomationRunRow(row) : null);
}

export type AutomationRunCleanupTarget = {
  runId: string;
  status: AutomationRunStatus;
  sessionId: string | null;
  projectId: string | null;
};

export async function listAutomationRunCleanupTargets(
  automationId: string
): Promise<AutomationRunCleanupTarget[]> {
  const rows = await db
    .select({
      runId: automationRuns.id,
      status: automationRuns.status,
      sessionId: sessions.id,
      projectId: sessions.projectId,
    })
    .from(automationRuns)
    .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
    .where(eq(automationRuns.automationId, automationId));

  return rows.map((row) => ({
    ...row,
    status: asRunStatus(row.status, row.runId),
  }));
}

export async function insertRun(input: {
  automationId: string;
  triggerConfigSnapshot: TriggerConfig;
  agentConfigSnapshot: AgentConfig;
  sessionConfigSnapshot?: StoredAutomationSessionConfig | null;
  scheduledAt?: number | null;
  deadlineAt?: number | null;
  status: AutomationRunStatus;
  triggerKind: AutomationRunTriggerKind;
  startedAt?: number | null;
  sessionCreatedAt?: number | null;
  launchedAt?: number | null;
  finishedAt?: number | null;
  generatedSessionName?: string | null;
  error?: RunError | null;
}): Promise<AutomationRun> {
  const [row] = await db
    .insert(automationRuns)
    .values({
      id: randomUUID(),
      automationId: input.automationId,
      scheduledAt: input.scheduledAt ?? null,
      deadlineAt: input.deadlineAt ?? null,
      startedAt: input.startedAt ?? null,
      sessionCreatedAt: input.sessionCreatedAt ?? null,
      launchedAt: input.launchedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      status: input.status,
      generatedSessionName: input.generatedSessionName ?? generateRandom(),
      error: input.error ? JSON.stringify(input.error) : null,
      triggerKind: input.triggerKind,
      triggerConfigSnapshot: JSON.stringify(input.triggerConfigSnapshot),
      agentConfigSnapshot: JSON.stringify(input.agentConfigSnapshot),
      sessionConfigSnapshot: input.sessionConfigSnapshot
        ? JSON.stringify(input.sessionConfigSnapshot)
        : null,
    })
    .returning();
  const run = mapAutomationRunRow(row);
  observeRun(run);
  return run;
}

export async function updateRun(
  id: string,
  values: Partial<
    Pick<
      AutomationRun,
      | 'scheduledAt'
      | 'deadlineAt'
      | 'startedAt'
      | 'sessionCreatedAt'
      | 'launchedAt'
      | 'finishedAt'
      | 'status'
      | 'error'
    >
  >
): Promise<AutomationRun | null> {
  const { error, ...rest } = values;
  const dbValues = {
    ...rest,
    ...(error !== undefined ? { error: error ? JSON.stringify(error) : null } : {}),
  };
  const [row] = await db
    .update(automationRuns)
    .set(dbValues)
    .where(eq(automationRuns.id, id))
    .returning();
  return observeRun(row ? mapAutomationRunRow(row) : null);
}

export async function findRunsStuckInCreatingSession(): Promise<Array<{ id: string }>> {
  const rows = await db
    .select({ id: automationRuns.id, sessionId: sessions.id })
    .from(automationRuns)
    .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
    .where(and(eq(automationRuns.status, 'creating_session'), isNull(sessions.id)));
  return rows.map((r) => ({ id: r.id }));
}

export async function findRunsStuckInLaunchingSession(): Promise<
  Array<{ id: string; sessionId: string }>
> {
  const rows = await db
    .select({ id: automationRuns.id, sessionId: sessions.id })
    .from(automationRuns)
    .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
    .where(eq(automationRuns.status, 'launching_session'));
  return rows.filter((r): r is { id: string; sessionId: string } => r.sessionId !== null);
}

export async function findRunsStuckInStartingAgent(): Promise<
  Array<{ id: string; sessionId: string }>
> {
  const rows = await db
    .select({ id: automationRuns.id, sessionId: sessions.id })
    .from(automationRuns)
    .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
    .where(eq(automationRuns.status, 'starting_agent'));
  return rows.filter((r): r is { id: string; sessionId: string } => r.sessionId !== null);
}

export async function getRun(id: string): Promise<AutomationRun | null> {
  const [row] = await db
    .select({ run: automationRuns, sessionId: sessions.id })
    .from(automationRuns)
    .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
    .where(eq(automationRuns.id, id))
    .limit(1);
  return row ? mapAutomationRunRow(row.run, row.sessionId) : null;
}

export async function removeRun(id: string): Promise<boolean> {
  const deleted = await db
    .delete(automationRuns)
    .where(eq(automationRuns.id, id))
    .returning({ id: automationRuns.id });
  return deleted.length > 0;
}
