import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import { defaultHookEventParser } from '@gugu/session-core/agents/plugins/helpers';
import { eq } from 'drizzle-orm';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { parsePtyId } from '@main/core/pty/ptyId';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { AgentEvent } from '@shared/core/agents/agentEvents';
import type { RawHookRequest } from './hook-server';
import { learnHarnessConfigRoot } from './harness-config-roots';

export type SessionContext = {
  sessionId: string;
  projectId: string;
  providerId: string;
  ptyId: string;
  /** The spawn whose token carried this event; a retired spawn keeps its own id. */
  sourceId: string;
  /** When its hook reached the hook server (`RawHookRequest.receivedAt`): the event's time. */
  receivedAt: number;
};

export type ParsedHookEvent =
  | { kind: 'status'; event: AgentEvent }
  | { kind: 'session'; ctx: SessionContext; providerSessionId: string }
  | { kind: 'ignore' };

async function resolveContext(raw: RawHookRequest): Promise<SessionContext | null> {
  const { ptyId } = raw;
  const parsed = parsePtyId(ptyId);
  if (!parsed) return null;

  const [row] = await db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, parsed.sessionId))
    .limit(1);

  if (!row) return null;

  return {
    sessionId: parsed.sessionId,
    projectId: row.projectId,
    providerId: parsed.providerId,
    ptyId,
    sourceId: raw.sourceId,
    receivedAt: raw.receivedAt,
  };
}

function parseBody(raw: RawHookRequest): Record<string, unknown> {
  if (!raw.body) return {};
  try {
    const value: unknown = JSON.parse(raw.body);
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  } catch {}
  return {};
}

/** 规范 hook 事件 → `AgentEvent`(纯函数;`timestamp` 是 hook 到达 hook server 的那一刻,`ctx.receivedAt`)。 */
export function canonicalToAgentEvent(
  canonical: CanonicalHookEvent & { kind: 'status' },
  ctx: SessionContext
): AgentEvent {
  return {
    type: canonical.type,
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    timestamp: ctx.receivedAt,
    payload: {
      notificationType: canonical.notificationType,
      message: canonical.message,
      lastAssistantMessage: canonical.lastAssistantMessage,
      // 各家解析器量得到才给;缺席 = 这一家不报,原样缺席(❌ 在这里补 0 或补默认原因)。
      ...(canonical.backgroundTasks !== undefined ? { backgroundTasks: canonical.backgroundTasks } : {}),
      ...(canonical.scheduledTasks !== undefined ? { scheduledTasks: canonical.scheduledTasks } : {}),
      ...(canonical.outcome ? { outcome: canonical.outcome } : {}),
      ...(canonical.waitKind ? { waitKind: canonical.waitKind } : {}),
      ...(canonical.waitId ? { waitId: canonical.waitId } : {}),
      ...(canonical.signInRequired ? { signInRequired: true } : {}),
      ...(canonical.origin ? { origin: canonical.origin } : {}),
    },
  };
}

export async function parseHookEvent(raw: RawHookRequest): Promise<ParsedHookEvent> {
  const ctx = await resolveContext(raw);
  if (!ctx) {
    throw new Error(`Unrecognised ptyId: ${raw.ptyId}`);
  }

  const body = parseBody(raw);
  const plugin = getPlugin(ctx.providerId);
  // harness 在 hook 里报了它实际用的配置目录:记下,在场读者和会话记录都先认它(见 harness-config-roots)。
  learnHarnessConfigRoot({ sessionId: ctx.sessionId, providerId: ctx.providerId, report: body });
  const parser = plugin?.behavior.hooks?.parseHookEvent ?? defaultHookEventParser;
  const canonical = parser(raw.type, body);

  if (canonical.kind === 'ignore') return { kind: 'ignore' };

  if (canonical.kind === 'session') {
    return { kind: 'session', ctx, providerSessionId: canonical.providerSessionId };
  }

  return { kind: 'status', event: canonicalToAgentEvent(canonical, ctx) };
}
